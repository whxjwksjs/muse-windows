# Muse for Windows

Desktop app for Muse on Windows. Meta only ships Mac, iOS, Android, and web
clients, so this wraps the web app in a native window (same trick as the
official Mac app). It does **not** give the agent access to your PC; it is
your chat with Muse in a desktop window.

## Features (v1.1)

- Main window for muse.ai, remembers size and position
- System tray icon; closing the window parks the app in the tray
- Quick chat popup: **Ctrl+Shift+Space** anywhere, hides when it loses focus
- **Profiles**: separate isolated sessions per profile, so two people can each
  stay signed in and switch from the tray. "Sign out" wipes the current
  profile's login.
- **Muse / Meta AI toggle**: **Ctrl+Shift+M** or the tray menu switches the
  window between muse.ai and meta.ai. They are separate products with
  separate logins; the toggle just switches sites, it does not merge them.
  The switch reuses the current window instead of restarting it.
- **Saved Meta AI accounts**: each profile keeps its own isolated login/session.
  On Meta AI, the tray has an account switcher plus "Add Meta AI account…".
  **Ctrl+Shift+N** cycles through saved Meta AI accounts and can be remapped
  in Settings & Hotkeys.
  Meta AI's voice chat and TTS are available when you're on its tab, and the
  app grants microphone access for voice chat (muse.ai and meta.ai only).
- **Save clipboard text as .txt**: tray menu item dumps the clipboard to
  `Documents/Muse clips/clip-<timestamp>.txt` and opens its folder, so huge
  pastes can be dragged into chat as a file instead of freezing the input.
- **Right-click menu + downloads**: Save link as / Save image as / Copy link
  address, standard cut-copy-paste. Downloads ask where to save and notify on
  completion.
- **Automation / Auto-Allow controls**: automation is opt-in and off by default. A remappable global hotkey, tray controls, and an on-screen widget can toggle the master switch. Auto-Allow All is explicit, and per-site rules can be set for individual connector/action categories. Any automation can be disabled from the same controls.
- **Mic / speaker toggles + customizable hotkeys**: tray menu or global
  hotkeys mute the microphone (for voice chat) and the app's speaker.
  "Customize hotkeys…" opens a settings screen where every global hotkey can
  be remapped. Mic selection itself isn't possible at the app level; the site
  uses your Windows default input device.
- Zoom: **Ctrl+= / Ctrl+- / Ctrl+0** in the main window
- GPU rasterization flags for smoother scrolling
- Run on startup toggle
- Auto-update via GitHub Releases (see below)

## Run from source

1. Install Node.js LTS from https://nodejs.org
2. `npm install`
3. `npm start`

## Build the Windows installer (on a Windows PC)

The installer target needs Windows to finalize (wine on Linux cannot do it):

1. Install Node.js LTS
2. `npm install`
3. `npm run dist`
4. Find `dist/Muse Setup 1.1.0.exe` (installer) and `dist/Muse-Portable-1.1.0.exe`
   (no-install portable) plus `dist/latest.yml`

The portable build can also be produced on Linux/macOS; only the NSIS
installer needs Windows.

## Auto-update setup

1. Create a **public** GitHub repo named `muse-windows` under your account
   (the app is preconfigured for `whxjwksjs/muse-windows`; change
   `build.publish` in package.json if yours differs)
2. Build on Windows with `npm run dist`
3. Create a GitHub Release and upload `Muse Setup 1.1.0.exe` **and**
   `latest.yml` (electron-builder generates it in `dist/`)
4. The app checks for updates 30 seconds after launch and every 6 hours, and
   via Tray > Check for updates. Download is automatic; install happens on
   restart from the tray menu.

Notes: updates work best with the installed (NSIS) build; the portable build
will notify but is easiest updated by downloading the new portable. Without
a code-signing certificate Windows SmartScreen warns on first run and on
updates; click More info > Run anyway.

## Storage

The ~100 MB size is almost entirely Chromium, which the app needs to run.
`compression: maximum` is already set; a zip of the unpacked app saves only
a few MB. Runtime disk use is the full unpacked size regardless.
