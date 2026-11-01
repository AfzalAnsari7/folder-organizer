# 📁 Folder Organizer

A simple local web app for browsing, searching, cleaning up and auto-arranging the files on your Mac. It runs only on your computer, needs no install beyond Node.js, and has zero dependencies.

## Features

- **Thread Map view.** The folder you're in sits at the centre, and its files and folders are linked to it by animated threads. You can drag items onto folder nodes to move them. List and grid views are also available.
- **Smart sidebar.** Favorites with sizes, pinned folders, recent places, a "jump to folder" filter, and a disk-usage meter.
- **Smart collections.** Recent (last 7 days), Large files (100 MB+), Screenshots, Installers, and Old downloads (90+ days), answered instantly from a background index of your home folder.
- **Quick Look preview.** Press Space to preview images, PDFs, audio and text files, with details and quick actions.
- **Tidy folder.** One click sorts the loose files in a folder into Documents, Images, Spreadsheets, Installers and other category folders. You see what will move first, and it refuses to run in code projects.
- **Rename, move and trash.** Drag and drop onto folders anywhere (map, list, sidebar or breadcrumb). A glowing thread shows each move.
- **Bulk rename.** Select several items to find-and-replace in their names (extensions are kept) or number them, such as "Invoice 1, Invoice 2…", with a live preview.
- **Cleanup.** Finds duplicates by checking size, then the first 64 KB, then the full file contents. It keeps the copy with the original name, and flags `file (1).pdf` copies that are identical to their original as safe to delete. It also lists the largest files and files untouched for a year.
- **Auto-arrange rules.** Hazel-style rules such as "PDFs in Downloads older than 30 days go to Downloads/Archive". Preview exactly what will move, then arrange. You can also switch them on to run automatically every 10 minutes while the app is open. Files changed in the last 2 minutes are skipped, so downloads in progress are left alone.
- **Undo.** Nothing is permanently deleted. Every change is logged in History and can be undone, including restoring items from the Trash. Folders created by a change are removed again if they're left empty.

## Run it

```bash
git clone https://github.com/AfzalAnsari7/folder-organizer.git
cd folder-organizer
npm start          # or: node server.js
```

It opens at <http://localhost:4321>. To use another port, run `PORT=5000 npm start`.

### macOS permissions

- The first time you trash something, macOS asks whether your terminal may control **Finder**. Click **OK** so the Trash's "Put Back" works. If you decline, files still go to the Trash and undo still works.
- If you see "macOS blocked access", open **System Settings → Privacy & Security → Full Disk Access** and enable your terminal app.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Click / ⌘-click / ⇧-click | Select one / toggle / select a range |
| Double-click | Open a folder or file |
| Space | Show / hide the preview pane |
| Enter | Rename |
| ⌘⌫ or Delete | Move to Trash |
| ⌘A | Select all |
| ⌘Z | Undo |
| ⌘K or / | Search |
| Esc | Clear search / selection |

## Safety

- The server listens only on `127.0.0.1` and requires a random per-session token. Other websites can't call it.
- Only paths inside your home folder can be accessed.
- System folders (Desktop, Documents, Downloads, Library and others) can't be moved, renamed or trashed, though their contents can.
- History, rules and settings are stored in `~/.folder-organizer/`.

## License

MIT
