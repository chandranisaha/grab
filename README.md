# grab

Press **Ctrl+Q** anywhere, pick something on your screen, and ask Claude about it. Click an object, circle it, or drag a box. The answer shows up in a small frosted window next to it, so you never leave the app you're in.

## Using it

| Key or action | What it does |
|---|---|
| Ctrl+Q | Freeze the screen and start a grab |
| Hover | Highlights the button, panel, text block or window under the cursor, with its name |
| Click | Selects that object. For a large area with nothing finer to pick, such as a picture in a PDF, grab finds the object's edges in the image itself |
| Draw a loop | Selects what's inside it |
| Drag in a straight line (or hold Shift) | Selects a box |
| Ctrl+A | Selects the whole screen |
| Tab / Shift+Tab | Cycles the quick actions (Explain, In 1-2 lines, Solve, Fix this error, Summarize, Translate, Copy text) |
| Enter | Send |
| Esc | Cancel; nothing is captured or sent |

### The answer window

- **grab** (the name, top left): opens the dashboard
- **Fast / Smart**: switches the model for the next reply (Haiku 5.5 or Sonnet 5.5)
- **1-2 lines** (Ctrl+B): shortens the last answer to one or two lines
- **Pin** (Ctrl+P): keeps the window on top, stops it fading, and makes new grabs open in a new window beside it instead of replacing it
- **Copy** (Ctrl+C with nothing selected): copies the last answer
- **More**: new grab, save as a Markdown note (the image is saved next to it), copy the whole conversation, open the dashboard, and an opacity slider
- A follow-up box at the bottom keeps the image and the earlier conversation

Each answer shows how long the first words took. An unpinned window fades after 10 seconds without activity and comes back when you hover over it.

### Dashboard

Open it by clicking the name in an answer window, from the tray icon, or from the tray menu.

- **Home**: grabs today, in the last 7 days and in total; median time to first words; grabs per day; which models you used; your connection status; recent grabs
- **History**: every grab with its picture and the full conversation, searchable (Ctrl+F) and filterable. You can star a grab, copy it, delete it, or **Continue** it in a new answer window
- **Settings**: connection, shortcut, default model, click-to-select, history, launch at login, and the default opacity

History is kept on this computer only (`history.json` and the images in the app's data folder). You can turn it off in Settings or clear it.

## Setup

```
npm install
npm start
```

grab sits in the system tray and starts with Windows.

### Connecting to Claude

By default grab uses your Claude account (Pro or Max) through Claude Code, so you don't need an API key. It looks for Claude Code on your PATH, in `~/.local/bin`, and in the copy that comes with the Claude desktop app. If you aren't signed in, Settings shows a **Sign in** button that runs `claude auth login`. grab runs Claude Code with every tool, plugin and MCP server turned off, so it can only read the image you send and reply in text.

To make the first answer arrive sooner, grab starts Claude Code the moment you press the shortcut, while you're still choosing what to select. If you don't send anything, that process stops after 90 seconds.

If you'd rather pay per request, switch Settings to **API key** and paste a key from console.anthropic.com. The key is encrypted with the OS keychain (Electron `safeStorage`) and never written in plain text.

If `npm install` can't download Electron because of the native unzip helper, unzip `%LOCALAPPDATA%\electron\Cache\...\electron-v45.5.0-win32-x64.zip` into `node_modules\electron\dist` and put `electron.exe` in `node_modules\electron\path.txt`.

## Building an installer

```
npm run dist
```

This makes a one-click NSIS installer in `dist/`. On a PC with Smart App Control turned on, Windows blocks unsigned builds, both the installer step and the packaged `grab.exe`. Either sign the build or run it with `npm start`, which uses Electron's own signed runtime.

## How it works

- `src/main.js`: tray, shortcut, screen capture, answer windows (several, so pinned ones can stay), the dashboard, and the Claude call through Claude Code or the API.
- `src/claude-code.js`: finds Claude Code and runs one `claude -p` process per conversation, streaming JSON in and out.
- `src/uia.js` and `src/native/uia.ps1`: a small PowerShell helper that lists visible windows and, through Windows UI Automation, the buttons, text and panels inside them. This is how click-to-select knows where objects are. On macOS, clicking falls back to edge detection in the image.
- `src/history.js`: the local history and the dashboard's statistics.
- `src/renderer/overlay.*`: the frozen screen, object highlighting, freehand and box selection, and the ask bar.
- `src/renderer/answer.*`: the answer window. The frosted background is a blurred copy of the screen behind it, so the glass look holds whether or not the window has focus.
- `src/renderer/dashboard.*`: the dashboard.

Only the selected region is sent, and only when you press Enter.

## Not in this version

Asking about two regions at once, custom quick actions, and offline OCR.
