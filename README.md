# Grab

Press **Ctrl+Q** anywhere, circle something on your screen, and ask Claude about it. The answer shows up in a small frosted window next to what you circled, so you never leave the app you're in.

## Using it

| Key | What it does |
|---|---|
| Ctrl+Q | Freeze the screen and start a grab |
| Draw a loop | Select what's inside it |
| Drag in a straight line (or hold Shift) | Select a box |
| Single click | Select the whole screen |
| Tab / Shift+Tab | Cycle the quick actions (Explain, Solve, Fix this error, Summarize, Translate, Copy text) |
| Enter | Send |
| Esc | Cancel; nothing is captured or sent |
| Ctrl+P | Pin the answer so it doesn't fade |
| Ctrl+C (no text selected) | Copy the whole answer |

Fast uses Claude Haiku 5.5. Smart uses Claude Sonnet 5.5. You can switch in the ask bar or set a default in Settings.

The answer window has pin, copy, save-as-note (Markdown, with the image saved next to it), an opacity slider, and a follow-up box that keeps the image and the earlier conversation. When it isn't pinned, it fades after 10 seconds of no activity and comes back when you hover over it.

## Setup

```
npm install
npm start
```

The first launch opens Settings. Paste your Claude API key from console.anthropic.com. It's encrypted with the OS keychain (Electron `safeStorage`) and never written in plain text. Grab then sits in the system tray and starts with Windows. You can turn that off in Settings or from the tray menu.

If `npm install` can't download Electron because of the native unzip helper, unzip `%LOCALAPPDATA%\electron\Cache\...\electron-v45.5.0-win32-x64.zip` into `node_modules\electron\dist` and put `electron.exe` in `node_modules\electron\path.txt`.

## Building an installer

```
npm run dist
```

This makes a one-click NSIS installer in `dist/`. On a PC with Smart App Control turned on, Windows blocks unsigned builds, both the installer step and the packaged `Grab.exe`. Either sign the build or run it with `npm start`, which uses Electron's own signed runtime.

## How it works

- `src/main.js`: tray, global shortcut, screen capture (`desktopCapturer`), and the Claude streaming call (`@anthropic-ai/sdk`). The overlay windows (one per monitor) and the answer window are created once at startup and only shown or hidden after that.
- `src/renderer/overlay.*`: the frozen, dimmed screenshot; freehand and box selection; the ask bar. The crop is cut from the full-resolution capture and scaled down so the long edge is at most 1,500 px.
- `src/renderer/answer.*`: the streamed answer, rendered with marked, KaTeX and highlight.js. The frosted background is a blurred copy of the screen behind the window, so the glass look holds whether or not the window has focus.
- `src/renderer/settings.*`: API key, shortcut recorder, default model, launch at login.

Only the selected region is sent, and only when you press Enter. Nothing is saved to disk unless you save a note.

## Not in this version

Picking a single window with one click (a click takes the whole screen for now), history, multi-region grabs, custom quick actions, and offline OCR.
