#!/usr/bin/env node
// Folder Organizer — a local web UI to browse, search, clean up and arrange
// the files in your home folder. Zero dependencies. macOS only (uses Finder
// for Trash so "Put Back" and undo work).

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 4321;
const HOST = '127.0.0.1';
const HOME = os.homedir();
const DATA_DIR = path.join(HOME, '.folder-organizer');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const RULES_FILE = path.join(DATA_DIR, 'rules.json');
const PINS_FILE = path.join(DATA_DIR, 'pins.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DAY = 24 * 3600 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Automatic arranging: how often it runs, and how long a file must sit
// untouched first (so half-finished downloads and saves are left alone).
const AUTO_EVERY = 10 * 60 * 1000;
const AUTO_SETTLE = 2 * 60 * 1000;

// Random per-run token: other websites open in your browser can't read it,
// so they can't call this API (blocks CSRF / drive-by deletes).
const TOKEN = crypto.randomBytes(24).toString('hex');

// Folders we never descend into while searching/analyzing.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'venv', '.venv', '__pycache__', 'Library', '.Trash',
  '.cache', '.npm', '.vscode', 'Applications', '.folder-organizer',
]);
// Paths that can never be moved, renamed or trashed.
const PROTECTED = new Set(
  ['', 'Library', 'Desktop', 'Documents', 'Downloads', 'Applications', 'Movies',
   'Music', 'Pictures', 'Public', '.Trash'].map(p => path.join(HOME, p))
);

const CATEGORIES = {
  Documents: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'pages', 'odt', 'ppt', 'pptx', 'key'],
  Spreadsheets: ['xls', 'xlsx', 'csv', 'numbers', 'ods', 'tsv'],
  Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'bmp', 'tiff', 'ico'],
  Videos: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'],
  Audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'],
  Archives: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2'],
  Installers: ['dmg', 'pkg', 'exe', 'msi', 'app'],
  Code: ['js', 'ts', 'py', 'html', 'css', 'json', 'java', 'go', 'rb', 'php', 'sh', 'sql', 'xml', 'yml', 'yaml'],
};
const EXT_CATEGORY = {};
for (const [cat, exts] of Object.entries(CATEGORIES)) for (const e of exts) EXT_CATEGORY[e] = cat;
const extOf = name => path.extname(name).slice(1).toLowerCase();
const categoryOf = name => EXT_CATEGORY[extOf(name)] || 'Other';
const COPY_RE = /( \(\d+\)| copy( \d+)?)$/i;
const stem = name => name.replace(/\.[^.]+$/, '');

// Files the preview pane may stream to the browser, and files it shows as text.
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', pdf: 'application/pdf',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
};
const TEXT_EXTS = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'js', 'ts', 'py', 'html', 'css', 'xml', 'yml', 'yaml',
  'sh', 'sql', 'log', 'ini', 'java', 'go', 'rb', 'php']);

// Smart collections, answered from the index.
const SMART = {
  recent: { label: 'Recent', test: f => f.mtime > Date.now() - 7 * DAY, sort: (a, b) => b.mtime - a.mtime },
  large: { label: 'Large files', test: f => f.size >= 100 * 1024 ** 2, sort: (a, b) => b.size - a.size },
  screenshots: { label: 'Screenshots', test: f => /^(screenshot|screen shot|screen recording)/i.test(f.name), sort: (a, b) => b.mtime - a.mtime },
  installers: { label: 'Installers', test: f => ['dmg', 'pkg', 'exe', 'msi'].includes(extOf(f.name)), sort: (a, b) => b.size - a.size },
  oldDownloads: { label: 'Old downloads', test: f => f.path.startsWith(path.join(HOME, 'Downloads') + path.sep) && f.mtime < Date.now() - 90 * DAY, sort: (a, b) => b.size - a.size },
};

// Folders that look like code projects; "Tidy" refuses to reshuffle them.
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'Gemfile', 'composer.json'];

const DEFAULT_RULES = [
  { name: 'PDFs → Downloads/PDFs', folder: 'Downloads', exts: ['pdf'], dest: 'PDFs' },
  { name: 'Excel & CSV → Downloads/Spreadsheets', folder: 'Downloads', exts: ['xls', 'xlsx', 'csv'], dest: 'Spreadsheets' },
  { name: 'Images → Downloads/Images', folder: 'Downloads', exts: CATEGORIES.Images, dest: 'Images' },
  { name: 'Installers & archives → Downloads/Installers', folder: 'Downloads', exts: ['dmg', 'pkg', 'zip', 'rar', '7z'], dest: 'Installers' },
  { name: 'Screenshots → Desktop/Screenshots', folder: 'Desktop', exts: ['png'], nameContains: 'Screenshot', dest: 'Screenshots' },
].map((r, i) => ({ id: 'r' + (i + 1), nameContains: '', olderThanDays: 0, enabled: true, ...r }));

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// Resolve a user-supplied path and make sure it stays inside HOME.
function safePath(p) {
  if (typeof p !== 'string' || !p) throw new HttpError(400, 'Missing path');
  const abs = path.resolve(p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);
  if (abs !== HOME && !abs.startsWith(HOME + path.sep)) throw new HttpError(403, 'Only files inside your home folder are allowed');
  return abs;
}
function assertChangeable(abs) {
  if (PROTECTED.has(abs)) throw new HttpError(403, `"${path.basename(abs) || abs}" is a system folder and can't be changed`);
}
function validName(name) {
  if (typeof name !== 'string' || !name.trim() || name.includes('/') || name === '.' || name === '..')
    throw new HttpError(400, 'Invalid name');
  return name.trim();
}
const exists = p => fsp.lstat(p).then(() => true, () => false);

// "file.pdf" -> "file (2).pdf" until free
async function freeName(dir, name) {
  let target = path.join(dir, name);
  if (!(await exists(target))) return target;
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    target = path.join(dir, `${base} (${i})${ext}`);
    if (!(await exists(target))) return target;
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, data) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2));
}

// madeDirs: folders this change created, removed again on undo if left empty.
async function addHistory(type, label, ops, madeDirs) {
  const history = await readJson(HISTORY_FILE, []);
  const entry = { id: crypto.randomUUID(), time: new Date().toISOString(), type, label, ops };
  if (madeDirs && madeDirs.length) entry.madeDirs = madeDirs;
  history.unshift(entry);
  await writeJson(HISTORY_FILE, history.slice(0, 200));
  scheduleReindex();
  return entry;
}

function osascript(lines, args) {
  return new Promise((resolve, reject) => {
    const argv = lines.flatMap(l => ['-e', l]).concat(args);
    execFile('osascript', argv, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new HttpError(500, (stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

// Move items to the Trash through Finder (so "Put Back" works); returns the new
// paths inside the Trash. If Finder automation isn't allowed, move them into
// ~/.Trash directly — undo still works through our own history.
async function trashItems(paths) {
  try {
    return await finderTrash(paths);
  } catch (e) {
    if (!/-1743|Not authori[sz]ed/i.test(e.message)) throw e;
    const trashDir = path.join(HOME, '.Trash'), out = [];
    for (const p of paths) {
      const to = await freeName(trashDir, path.basename(p));
      await fsp.rename(p, to);
      out.push(to);
    }
    return out;
  }
}

async function restoreItem(trashed, original) {
  try {
    await finderRestore(trashed, original);
  } catch (e) {
    if (!/-1743|Not authori[sz]ed/i.test(e.message)) throw e;
    await fsp.rename(trashed, original);
  }
}

async function finderTrash(paths) {
  const out = await osascript([
    'on run argv',
    '  set out to {}',
    '  tell application "Finder"',
    '    repeat with p in argv',
    '      set t to delete ((POSIX file (p as text)) as alias)',
    '      set end of out to POSIX path of (t as alias)',
    '    end repeat',
    '  end tell',
    "  set AppleScript's text item delimiters to linefeed",
    '  return out as text',
    'end run',
  ], paths);
  return out.split('\n').map(s => s.replace(/\/$/, ''));
}

// Put an item back from the Trash to its original location/name.
async function finderRestore(trashed, original) {
  await osascript([
    'on run argv',
    '  tell application "Finder"',
    '    set m to move ((POSIX file (item 1 of argv)) as alias) to ((POSIX file (item 2 of argv)) as alias)',
    '    if name of m is not (item 3 of argv) then set name of m to (item 3 of argv)',
    '  end tell',
    'end run',
  ], [trashed, path.dirname(original), path.basename(original)]);
}

function entryInfo(dir, name, st) {
  const isDir = st.isDirectory(), full = path.join(dir, name);
  const agg = isDir ? index.dirs.get(full) : null; // folder size comes from the index
  return {
    name, path: full, isDir,
    size: isDir ? (agg ? agg.size : null) : st.size, items: agg ? agg.count : undefined, mtime: st.mtimeMs,
    ext: isDir ? '' : extOf(name), category: isDir ? 'Folder' : categoryOf(name),
  };
}

// Recursive walk that skips heavy/system folders and hidden ones.
async function walk(root, onFile, opts = {}) {
  const limit = opts.limit || 200000;
  let count = 0;
  const stack = [root];
  while (stack.length && count < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && !opts.hidden) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.endsWith('.app')) continue;
        if (opts.includeDirs) { await onFile(full, e.name, true); count++; }
        stack.push(full);
      } else if (e.isFile()) {
        await onFile(full, e.name, false);
        if (++count >= limit) break;
      }
    }
  }
  return { truncated: count >= limit };
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// Hash of the first 64 KB — a cheap first pass before hashing whole files.
const HEAD = 64 * 1024;
async function hashHead(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD);
    const { bytesRead } = await fh.read(buf, 0, HEAD, 0);
    return crypto.createHash('sha1').update(buf.subarray(0, bytesRead)).digest('hex');
  } finally { await fh.close(); }
}

async function groupBy(items, keyFn) {
  const groups = new Map();
  for (const it of items) {
    let k;
    try { k = await keyFn(it); } catch { continue; }
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  return [...groups.values()].filter(g => g.length > 1);
}

// Which copy of a duplicate to keep: an original name over "(1)"/"copy",
// then the shallowest path, then the oldest file.
function keepFirst(group) {
  const score = f => [COPY_RE.test(stem(f.name)) ? 1 : 0, f.path.split(path.sep).length, f.mtime];
  return group.sort((a, b) => {
    const x = score(a), y = score(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
}

// ---------- index ----------
// An in-memory index of the home folder (same skip rules as walk) that powers
// smart collections, folder sizes and sidebar counts. Rebuilt on start, every
// few minutes, and shortly after every change made through the app.
let index = { files: [], dirs: new Map(), builtAt: 0 };
let indexing = null, indexPending = false, reindexTimer = null;

async function buildIndex() {
  const files = [], dirs = new Map([[HOME, { size: 0, count: 0 }]]);
  const stack = [HOME];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    await Promise.all(entries.map(async e => {
      if (e.name.startsWith('.')) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.endsWith('.app')) return;
        dirs.set(full, { size: 0, count: 0 });
        stack.push(full);
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(full);
          files.push({ path: full, name: e.name, size: st.size, mtime: st.mtimeMs });
        } catch {}
      }
    }));
  }
  // Roll each file's size up into every ancestor folder.
  for (const f of files) {
    for (let d = path.dirname(f.path); ; d = path.dirname(d)) {
      const agg = dirs.get(d);
      if (agg) { agg.size += f.size; agg.count++; }
      if (d === HOME || d === path.dirname(d)) break;
    }
  }
  index = { files, dirs, builtAt: Date.now() };
}
function reindex() {
  if (indexing) { indexPending = true; return indexing; }
  indexing = buildIndex()
    .catch(e => console.error('Indexing failed:', e.message))
    .finally(() => { indexing = null; if (indexPending) { indexPending = false; reindex(); } });
  return indexing;
}
function scheduleReindex(ms = 1200) {
  clearTimeout(reindexTimer);
  reindexTimer = setTimeout(reindex, ms);
}
const indexReady = () => (index.builtAt ? null : reindex());

// ---------- API handlers ----------

const api = {
  'GET /api/roots': async () => {
    await indexReady();
    const quick = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music'];
    const projects = [];
    for (const e of await fsp.readdir(HOME, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && !PROTECTED.has(path.join(HOME, e.name))) projects.push(e.name);
    }
    const countOf = async p => {
      try { return (await fsp.readdir(p)).filter(n => !n.startsWith('.')).length; } catch { return null; }
    };
    const folder = async p => ({ name: path.basename(p), path: p, count: await countOf(p), size: index.dirs.get(p)?.size ?? null });
    const pins = [];
    for (const p of await readJson(PINS_FILE, [])) if (await exists(p)) pins.push(await folder(p));
    let disk = null;
    try {
      const s = await fsp.statfs(HOME);
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {}
    return {
      home: HOME,
      homeInfo: await folder(HOME),
      favorites: await Promise.all(quick.map(n => folder(path.join(HOME, n)))),
      folders: await Promise.all(projects.sort((a, b) => a.localeCompare(b)).map(n => folder(path.join(HOME, n)))),
      pins,
      smart: Object.entries(SMART).map(([key, s]) => ({ key, label: s.label, count: index.files.filter(s.test).length })),
      disk,
      indexed: { files: index.files.length, folders: index.dirs.size, at: index.builtAt },
    };
  },

  'GET /api/smart': async q => {
    await indexReady();
    const s = SMART[q.kind];
    if (!s) throw new HttpError(404, 'Unknown collection');
    const all = index.files.filter(s.test);
    const results = [];
    // Re-stat the hits so a stale index never shows files that are gone.
    await Promise.all(all.sort(s.sort).slice(0, 500).map(async f => {
      try { results.push(entryInfo(path.dirname(f.path), f.name, await fsp.stat(f.path))); } catch {}
    }));
    return { label: s.label, results: results.sort(s.sort), total: all.length };
  },

  'POST /api/pins': async b => {
    const p = safePath(b.path);
    let pins = await readJson(PINS_FILE, []);
    pins = b.remove ? pins.filter(x => x !== p) : [...new Set([...pins, p])];
    await writeJson(PINS_FILE, pins);
    return { pins };
  },

  'GET /api/preview': async q => {
    const p = safePath(q.path);
    const st = await fsp.stat(p);
    const info = { ...entryInfo(path.dirname(p), path.basename(p), st), created: st.birthtimeMs, raw: !!MIME[extOf(p)] };
    if (st.isDirectory()) {
      const names = (await fsp.readdir(p)).filter(n => !n.startsWith('.')).sort((a, b) => a.localeCompare(b));
      info.children = names.length;
      info.sample = names.slice(0, 8);
    } else if (TEXT_EXTS.has(info.ext) && st.size > 0) {
      const fh = await fsp.open(p, 'r');
      try {
        const buf = Buffer.alloc(Math.min(4096, st.size));
        await fh.read(buf, 0, buf.length, 0);
        info.text = buf.toString('utf8');
      } finally { await fh.close(); }
    }
    return info;
  },

  'POST /api/open': async b => {
    const p = safePath(b.path);
    await new Promise((res, rej) => execFile('open', [p], e => (e ? rej(e) : res())));
    return { ok: true };
  },

  'GET /api/list': async q => {
    const dir = safePath(q.path || HOME);
    const hidden = q.hidden === '1';
    const names = await fsp.readdir(dir);
    const items = [];
    await Promise.all(names.map(async name => {
      if (!hidden && name.startsWith('.')) return;
      try { items.push(entryInfo(dir, name, await fsp.stat(path.join(dir, name)))); } catch {}
    }));
    return { path: dir, parent: dir === HOME ? null : path.dirname(dir), items };
  },

  'GET /api/search': async q => {
    const root = safePath(q.root || HOME);
    const term = (q.q || '').toLowerCase();
    const cat = q.category || '';
    const results = [];
    const { truncated } = await walk(root, async (full, name, isDir) => {
      if (results.length >= 500) return;
      if (term && !name.toLowerCase().includes(term)) return;
      if (cat && (isDir ? 'Folder' : categoryOf(name)) !== cat) return;
      try { results.push(entryInfo(path.dirname(full), name, await fsp.stat(full))); } catch {}
    }, { includeDirs: !cat || cat === 'Folder', limit: 300000 });
    return { results, truncated: truncated || results.length >= 500 };
  },

  'GET /api/dirs': async q => {
    const dir = safePath(q.path || HOME);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return {
      path: dir, parent: dir === HOME ? null : path.dirname(dir),
      dirs: entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort((a, b) => a.localeCompare(b)),
    };
  },

  'POST /api/mkdir': async b => {
    const parent = safePath(b.parent);
    const target = path.join(parent, validName(b.name));
    if (await exists(target)) throw new HttpError(409, 'A file or folder with that name already exists');
    await fsp.mkdir(target);
    const entry = await addHistory('mkdir', `Created folder "${b.name}"`, [{ to: target }]);
    return { ok: true, entry };
  },

  'POST /api/rename': async b => {
    const from = safePath(b.path);
    assertChangeable(from);
    const to = path.join(path.dirname(from), validName(b.newName));
    if (to === from) return { ok: true };
    if (await exists(to)) throw new HttpError(409, 'A file or folder with that name already exists');
    await fsp.rename(from, to);
    const entry = await addHistory('rename', `Renamed "${path.basename(from)}" → "${path.basename(to)}"`, [{ from, to }]);
    return { ok: true, entry };
  },

  'POST /api/rename-many': async b => {
    const ops = [], errors = [];
    for (const it of b.items || []) {
      try {
        const from = safePath(it.path);
        assertChangeable(from);
        const to = path.join(path.dirname(from), validName(it.newName));
        if (to === from) continue;
        if (await exists(to)) throw new HttpError(409, `"${path.basename(to)}" already exists`);
        await fsp.rename(from, to);
        ops.push({ from, to });
      } catch (e) { errors.push(`${path.basename(String(it.path))}: ${e.message}`); }
    }
    const entry = ops.length ? await addHistory('rename', `Renamed ${ops.length} item(s)`, ops) : null;
    return { ok: true, renamed: ops.length, errors, entry };
  },

  // Sort the loose files in a folder into category subfolders (Documents, Images, …).
  'POST /api/tidy': async b => {
    const dir = safePath(b.path);
    for (const m of PROJECT_MARKERS) {
      if (await exists(path.join(dir, m))) throw new HttpError(400, `"${path.basename(dir)}" looks like a code project (it has ${m}), so tidying could break it`);
    }
    const plan = await planTidy(dir);
    if (!b.apply) return { plan };
    return applyPlan(plan, n => `Tidied ${n} file(s) in "${path.basename(dir)}"`);
  },

  'POST /api/move': async b => {
    const dest = safePath(b.dest);
    if (!(await fsp.stat(dest)).isDirectory()) throw new HttpError(400, 'Destination is not a folder');
    const ops = [], errors = [];
    for (const p of b.paths || []) {
      try {
        const from = safePath(p);
        assertChangeable(from);
        if (dest === from || dest.startsWith(from + path.sep)) throw new HttpError(400, "Can't move a folder into itself");
        if (path.dirname(from) === dest) continue;
        const to = await freeName(dest, path.basename(from));
        await fsp.rename(from, to);
        ops.push({ from, to });
      } catch (e) { errors.push(`${path.basename(p)}: ${e.message}`); }
    }
    const entry = ops.length ? await addHistory('move', `Moved ${ops.length} item(s) to "${path.basename(dest)}"`, ops) : null;
    return { ok: true, moved: ops.length, errors, entry };
  },

  'POST /api/trash': async b => {
    const paths = (b.paths || []).map(safePath);
    paths.forEach(assertChangeable);
    if (!paths.length) return { ok: true };
    const trashed = await trashItems(paths);
    const ops = paths.map((from, i) => ({ from, to: trashed[i] }));
    const entry = await addHistory('trash', `Moved ${ops.length} item(s) to Trash`, ops);
    return { ok: true, entry };
  },

  'POST /api/undo': async b => {
    const history = await readJson(HISTORY_FILE, []);
    const idx = b.id ? history.findIndex(h => h.id === b.id) : 0;
    const entry = history[idx];
    if (!entry) throw new HttpError(404, 'Nothing to undo');
    const errors = [];
    for (const op of [...entry.ops].reverse()) {
      try {
        if (entry.type === 'mkdir') await fsp.rmdir(op.to); // only succeeds if still empty
        else if (entry.type === 'trash') {
          if (await exists(op.from)) throw new Error('something already exists at the original location');
          await restoreItem(op.to, op.from);
        } else {
          if (await exists(op.from)) throw new Error('something already exists at the original location');
          await fsp.mkdir(path.dirname(op.from), { recursive: true });
          await fsp.rename(op.to, op.from);
        }
      } catch (e) { errors.push(`${path.basename(op.from || op.to)}: ${e.message}`); }
    }
    // Deepest first, so a parent is empty by the time we reach it.
    for (const d of [...(entry.madeDirs || [])].sort((x, y) => y.length - x.length)) await fsp.rmdir(d).catch(() => {});
    history.splice(idx, 1);
    await writeJson(HISTORY_FILE, history);
    scheduleReindex();
    return { ok: true, label: entry.label, errors };
  },

  'GET /api/history': async () => ({ history: await readJson(HISTORY_FILE, []) }),

  'POST /api/reveal': async b => {
    const p = safePath(b.path);
    await new Promise((res, rej) => execFile('open', ['-R', p], e => (e ? rej(e) : res())));
    return { ok: true };
  },

  'GET /api/analyze': async q => {
    const root = safePath(q.root || HOME);
    const files = [];
    const { truncated } = await walk(root, async (full, name) => {
      try {
        const st = await fsp.stat(full);
        files.push({ path: full, name, size: st.size, mtime: st.mtimeMs, category: categoryOf(name) });
      } catch {}
    }, { limit: 150000 });

    // Duplicates, in three passes so most files are never read in full:
    // same size → same first 64 KB → same full-content hash.
    const duplicates = [];
    for (const bySize of await groupBy(files.filter(f => f.size >= 1024 && f.size <= 1024 ** 3), f => f.size)) {
      for (const byHead of await groupBy(bySize, f => hashHead(f.path))) {
        const exact = byHead[0].size <= HEAD ? [byHead] : await groupBy(byHead, f => hashFile(f.path));
        for (const g of exact) duplicates.push(keepFirst(g));
      }
    }
    duplicates.sort((a, b) => b[0].size * (b.length - 1) - a[0].size * (a.length - 1));

    // "(1)" / "copy" files; flag the ones identical to an original next to them.
    const byPath = new Map(files.map(f => [f.path, f]));
    const copies = [];
    for (const f of files) {
      const s = stem(f.name);
      if (!COPY_RE.test(s)) continue;
      const orig = byPath.get(path.join(path.dirname(f.path), s.replace(COPY_RE, '') + path.extname(f.name)));
      let exact = false;
      if (orig && orig.size === f.size) {
        try { exact = f.size <= HEAD ? (await hashHead(f.path)) === (await hashHead(orig.path)) : (await hashFile(f.path)) === (await hashFile(orig.path)); } catch {}
      }
      copies.push({ ...f, original: orig ? orig.name : null, exact });
      if (copies.length >= 300) break;
    }
    copies.sort((a, b) => b.exact - a.exact || b.size - a.size);

    const yearAgo = Date.now() - 365 * DAY;
    const byType = {};
    for (const f of files) {
      byType[f.category] ??= { count: 0, size: 0 };
      byType[f.category].count++;
      byType[f.category].size += f.size;
    }
    return {
      root, totalFiles: files.length, totalSize: files.reduce((s, f) => s + f.size, 0), truncated,
      duplicates: duplicates.slice(0, 100),
      duplicateGroups: duplicates.length,
      wasted: duplicates.reduce((s, g) => s + g[0].size * (g.length - 1), 0),
      large: [...files].sort((a, b) => b.size - a.size).slice(0, 50),
      old: files.filter(f => f.mtime < yearAgo).sort((a, b) => b.size - a.size).slice(0, 100),
      copies,
      byType,
    };
  },

  'GET /api/rules': async () => ({ rules: await readJson(RULES_FILE, DEFAULT_RULES) }),

  'POST /api/rules': async b => {
    if (!Array.isArray(b.rules)) throw new HttpError(400, 'rules must be a list');
    const rules = b.rules.map(r => ({
      id: r.id || 'r' + crypto.randomBytes(4).toString('hex'),
      name: String(r.name || 'Untitled rule'),
      folder: String(r.folder || ''),
      exts: (Array.isArray(r.exts) ? r.exts : String(r.exts || '').split(','))
        .map(e => e.trim().toLowerCase().replace(/^\./, '')).filter(Boolean),
      nameContains: String(r.nameContains || ''),
      olderThanDays: Math.max(0, Math.floor(Number(r.olderThanDays) || 0)),
      dest: String(r.dest || ''),
      enabled: r.enabled !== false,
    }));
    await writeJson(RULES_FILE, rules);
    return { rules };
  },

  'POST /api/rules/preview': async b => ({ plan: await planRules(b.ids) }),

  'POST /api/rules/apply': async b => applyPlan(await planRules(b.ids), n => `Auto-arranged ${n} file(s)`),

  'GET /api/settings': async () => readJson(SETTINGS_FILE, { autoArrange: false }),

  'POST /api/settings': async b => {
    const settings = { ...(await readJson(SETTINGS_FILE, {})), autoArrange: !!b.autoArrange };
    await writeJson(SETTINGS_FILE, settings);
    return settings;
  },
};

// Move each planned file (creating folders, never overwriting) as one undoable step.
async function applyPlan(plan, label) {
  const ops = [], errors = [], madeDirs = [];
  for (const { from, to } of plan) {
    try {
      const made = await fsp.mkdir(path.dirname(to), { recursive: true });
      // mkdir returns the topmost folder it created; record it and everything below.
      for (let d = path.dirname(to); made && d.length >= made.length; d = path.dirname(d)) madeDirs.push(d);
      const target = await freeName(path.dirname(to), path.basename(to));
      await fsp.rename(from, target);
      ops.push({ from, to: target });
    } catch (e) { errors.push(`${path.basename(from)}: ${e.message}`); }
  }
  const entry = ops.length ? await addHistory('move', label(ops.length), ops, madeDirs) : null;
  return { ok: true, moved: ops.length, errors, entry };
}

// Files directly inside dir → dir/<Category>/. Unknown types stay where they are.
async function planTidy(dir) {
  const plan = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    const folder = categoryOf(e.name);
    if (folder === 'Other') continue;
    plan.push({ folder, from: path.join(dir, e.name), to: path.join(dir, folder, e.name) });
  }
  return plan;
}

// Runs the enabled rules on a timer when the user has switched that on.
async function autoArrange() {
  if (!(await readJson(SETTINGS_FILE, {})).autoArrange) return;
  const r = await applyPlan(await planRules(null, AUTO_SETTLE), n => `Auto-arranged ${n} file(s) automatically`);
  if (r.moved) console.log(`  Auto-arranged ${r.moved} file(s)`);
}

// Work out which files each rule would move (top level of the rule's folder only).
async function planRules(ids, settleMs = 0) {
  const rules = (await readJson(RULES_FILE, DEFAULT_RULES)).filter(r => r.enabled && (!ids || ids.includes(r.id)));
  const plan = [], claimed = new Set();
  for (const r of rules) {
    let folder, destDir;
    try {
      folder = safePath(path.isAbsolute(r.folder) || r.folder.startsWith('~') ? r.folder : path.join(HOME, r.folder));
      destDir = safePath(path.isAbsolute(r.dest) || r.dest.startsWith('~') ? r.dest : path.join(folder, r.dest));
    } catch { continue; }
    if (!r.dest || destDir === folder) continue;
    let entries;
    try { entries = await fsp.readdir(folder, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      if (r.exts.length && !r.exts.includes(extOf(e.name))) continue;
      if (r.nameContains && !e.name.toLowerCase().includes(r.nameContains.toLowerCase())) continue;
      const from = path.join(folder, e.name);
      if (claimed.has(from)) continue;
      if (r.olderThanDays || settleMs) {
        const minAge = Math.max(r.olderThanDays * DAY, settleMs);
        try { if ((await fsp.stat(from)).mtimeMs > Date.now() - minAge) continue; } catch { continue; }
      }
      claimed.add(from);
      plan.push({ rule: r.name, ruleId: r.id, from, to: path.join(destDir, e.name) });
    }
  }
  return plan;
}

// ---------- server ----------

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  try {
    // Block DNS-rebinding: only answer to localhost names.
    const host = (req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(host)) return send(res, 403, { error: 'Forbidden host' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      return send(res, 200, html.replace('__TOKEN__', TOKEN), 'text/html; charset=utf-8');
    }

    // Raw file bytes for the preview pane (<img>/<iframe> can't send headers,
    // so the token rides in the query string).
    if (req.method === 'GET' && url.pathname === '/api/raw') {
      if (url.searchParams.get('t') !== TOKEN) return send(res, 401, { error: 'Bad token' });
      const p = safePath(url.searchParams.get('path'));
      const type = MIME[extOf(p)];
      const st = await fsp.stat(p);
      if (!type || !st.isFile()) return send(res, 415, { error: 'No preview for this file type' });
      const headers = { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (type === 'image/svg+xml') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
      res.writeHead(200, headers);
      return fs.createReadStream(p).pipe(res);
    }

    const handler = api[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { error: 'Not found' });
    if (req.headers['x-token'] !== TOKEN) return send(res, 401, { error: 'Bad token — reload the page' });

    let input = Object.fromEntries(url.searchParams);
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 5e6) throw new HttpError(413, 'Request too large');
      }
      input = raw ? JSON.parse(raw) : {};
    }
    send(res, 200, await handler(input));
  } catch (e) {
    const status = e.status || (e.code === 'ENOENT' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 500);
    const msg = e.code === 'EPERM' || e.code === 'EACCES'
      ? 'macOS blocked access. Give your terminal "Full Disk Access" in System Settings → Privacy & Security.'
      : e.message;
    send(res, status, { error: msg });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  📁 Folder Organizer running at ${url}\n  (Ctrl+C to stop)\n`);
  reindex();
  setInterval(reindex, 3 * 60 * 1000).unref();
  const runAuto = () => autoArrange().catch(e => console.error('Auto-arrange failed:', e.message));
  setTimeout(runAuto, 60 * 1000).unref();
  setInterval(runAuto, AUTO_EVERY).unref();
  if (!process.argv.includes('--no-open')) execFile('open', [url], () => {});
});
