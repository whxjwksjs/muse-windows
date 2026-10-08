const { app, BrowserWindow, Tray, Menu, MenuItem, globalShortcut, shell, nativeImage, clipboard, session, dialog, Notification, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const SITES = {
  muse: { name: 'Muse', url: 'https://muse.ai' },
  meta: { name: 'Meta AI', url: 'https://www.meta.ai/' },
};
// Global hotkeys, all user-remappable via the tray menu's "Customize hotkeys…".
const DEFAULT_HOTKEYS = {
  quick: 'CommandOrControl+Shift+Space',
  site: 'CommandOrControl+Shift+M',
  export: 'CommandOrControl+Shift+E',
  mic: 'CommandOrControl+Shift+U',
  speaker: 'CommandOrControl+Shift+O',
  automation: 'CommandOrControl+Shift+A',
  metaAccount: 'CommandOrControl+Shift+N',
};
const HOTKEY_LABELS = {
  quick: 'Quick chat popup',
  site: 'Switch Muse / Meta AI',
  export: 'Export this chat',
  mic: 'Mute / unmute microphone',
  speaker: 'Mute / unmute app sound',
  automation: 'Toggle automation (Auto-Allow)',
  metaAccount: 'Next Meta AI account',
};
const HOTKEY_ACTIONS = {
  quick: () => toggleQuickWindow(),
  site: () => toggleSite(),
  export: () => exportChat(),
  mic: () => toggleMic(),
  speaker: () => toggleSpeaker(),
  automation: () => toggleAutomationMaster(),
  metaAccount: () => switchMetaAccount(),
};

let mainWindow = null;
let quickWindow = null;
let tray = null;
let updateDownloaded = false;
let pendingUpdate = null;

app.setName('Muse');
app.setAppUserModelId('ai.muse.desktop');

// Performance: push raster work to the GPU. The page itself is still the
// bottleneck, but this removes the wrapper as a source of jank.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

// ---- persisted state ----------------------------------------------------
function defaultAutomation() {
  return {
    enabled: false,
    autoAllowAll: false,
    showOnScreenWidget: true,
    actions: {
      connectors: true,
      file_access: true,
      external_links: true,
      media_permissions: true,
      code_execution: true,
    },
    sites: {},
    siteActions: {},
  };
}

function defaultState() {
  return {
    window: {},
    site: 'muse',
    profiles: [{ id: 'default', name: 'Profile 1' }],
    activeProfileId: 'default',
    hotkeys: { ...DEFAULT_HOTKEYS },
    automation: defaultAutomation(),
  };
}
const statePath = () => path.join(app.getPath('userData'), 'app-state.json');
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    const merged = { ...defaultState(), ...raw };
    merged.hotkeys = { ...DEFAULT_HOTKEYS, ...(raw.hotkeys || {}) };
    merged.automation = {
      ...defaultAutomation(),
      ...(raw.automation || {}),
      actions: { ...defaultAutomation().actions, ...((raw.automation && raw.automation.actions) || {}) },
      sites: { ...((raw.automation && raw.automation.sites) || {}) },
      siteActions: { ...((raw.automation && raw.automation.siteActions) || {}) },
    };
    return merged;
  } catch {
    return defaultState();
  }
}
let state = loadState();
if (!state.profiles.some((p) => p.id === state.activeProfileId)) {
  state.activeProfileId = state.profiles[0].id;
}
function saveState() {
  try { fs.writeFileSync(statePath(), JSON.stringify(state, null, 2)); } catch { /* ignore */ }
}
saveState();

const activeProfile = () => state.profiles.find((p) => p.id === state.activeProfileId) || state.profiles[0];
const partitionFor = (profileId) => `persist:muse-${profileId}`;
const currentSite = () => SITES[state.site] || SITES.muse;

function notify(title, body, onClick) {
  const n = new Notification({ title, body });
  if (onClick) n.on('click', onClick);
  n.show();
}

// ---- windows ------------------------------------------------------------
const webPrefs = () => ({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: path.join(__dirname, 'preload-chat-export.js'),
  partition: partitionFor(state.activeProfileId),
});

function attachZoomShortcuts(win) {
  win.webContents.on('before-input-event', (e, input) => {
    if (!(input.control && !input.meta && !input.alt && input.type === 'keyDown')) return;
    const z = win.webContents.getZoomFactor();
    if (input.key === '=' || input.key === '+') {
      win.webContents.setZoomFactor(Math.min(2.0, +(z + 0.1).toFixed(2)));
      e.preventDefault();
    } else if (input.key === '-') {
      win.webContents.setZoomFactor(Math.max(0.5, +(z - 0.1).toFixed(2)));
      e.preventDefault();
    } else if (input.key === '0') {
      win.webContents.setZoomFactor(1.0);
      e.preventDefault();
    }
  });
}

function createMainWindow() {
  const saved = state.window || {};
  mainWindow = new BrowserWindow({
    width: saved.width || 1200,
    height: saved.height || 800,
    x: typeof saved.x === 'number' ? saved.x : undefined,
    y: typeof saved.y === 'number' ? saved.y : undefined,
    title: `${currentSite().name} (Muse desktop)`,
    autoHideMenuBar: true,
    backgroundColor: '#141414',
    show: false,
    webPreferences: webPrefs(),
  });

  mainWindow.loadURL(currentSite().url);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('did-finish-load', () => injectMicShim(mainWindow));
  attachZoomShortcuts(mainWindow);
  attachContextMenu(mainWindow);

  const persistBounds = () => {
    if (!mainWindow) return;
    const [width, height] = mainWindow.getSize();
    const [x, y] = mainWindow.getPosition();
    state.window = { width, height, x, y };
    saveState();
  };
  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);

  // Closing parks the app in the tray instead of quitting.
  mainWindow.on('close', (e) => {
    if (!app.quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createQuickWindow() {
  quickWindow = new BrowserWindow({
    width: 430,
    height: 600,
    title: `${currentSite().name} quick chat`,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    backgroundColor: '#141414',
    webPreferences: webPrefs(),
  });
  quickWindow.loadURL(currentSite().url);
  attachContextMenu(quickWindow);
  // Spotlight-style: hide when focus is lost.
  quickWindow.on('blur', () => { if (quickWindow) quickWindow.hide(); });
  quickWindow.on('closed', () => { quickWindow = null; });
}

function closeWindows() {
  if (quickWindow) { quickWindow.removeAllListeners('closed'); quickWindow.close(); quickWindow = null; }
  if (mainWindow) { mainWindow.removeAllListeners('closed'); mainWindow.close(); mainWindow = null; }
}

function toggleQuickWindow() {
  if (!quickWindow) createQuickWindow();
  if (quickWindow.isVisible()) {
    quickWindow.hide();
  } else {
    const { screen } = require('electron');
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const [w, h] = quickWindow.getSize();
    quickWindow.setPosition(
      Math.round(display.bounds.x + (display.bounds.width - w) / 2),
      Math.round(display.bounds.y + (display.bounds.height - h) / 2)
    );
    quickWindow.show();
    quickWindow.focus();
  }
}

function showMainWindow() {
  if (!mainWindow) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---- profiles & sites ----------------------------------------------------
function switchProfile(id) {
  if (id === state.activeProfileId) return;
  state.activeProfileId = id;
  saveState();
  closeWindows();
  createMainWindow();
  showMainWindow();
  buildTrayMenu();
}

function addProfile() {
  const id = `p${Date.now()}`;
  const profile = { id, name: `Profile ${state.profiles.length + 1}` };
  state.profiles.push(profile);
  saveState();
  setupDownloadHandler(id);
  setupPermissions(id);
  switchProfile(id);
  notify('New profile', `${profile.name} created. Sign in with the other account.`);
}

async function signOut() {
  const ses = session.fromPartition(partitionFor(state.activeProfileId));
  await ses.clearStorageData();
  closeWindows();
  createMainWindow();
  showMainWindow();
  notify('Signed out', `Signed out of ${currentSite().name} on ${activeProfile().name}.`);
}

function toggleSite() {
  state.site = state.site === 'muse' ? 'meta' : 'muse';
  saveState();
  // Reuse the existing window when possible. This keeps the switch feeling
  // like changing tabs instead of restarting the app.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(`${currentSite().name} (Muse desktop)`);
    mainWindow.loadURL(currentSite().url);
    if (quickWindow && !quickWindow.isDestroyed()) {
      quickWindow.setTitle(`${currentSite().name} quick chat`);
      quickWindow.loadURL(currentSite().url);
    }
    showMainWindow();
  } else {
    createMainWindow();
    showMainWindow();
  }
  buildTrayMenu();
}

function switchNextMetaAccount() {
  if (!state.profiles.length) return;
  const current = state.profiles.findIndex((p) => p.id === state.activeProfileId);
  const next = state.profiles[(current + 1) % state.profiles.length];
  switchMetaAccount(next.id);
}

function addMetaAccount() {
  const id = `p${Date.now()}`;
  const profile = { id, name: `Meta AI Account ${state.profiles.length + 1}` };
  state.profiles.push(profile);
  state.activeProfileId = id;
  state.site = 'meta';
  saveState();
  setupDownloadHandler(id);
  setupPermissions(id);
  closeWindows();
  createMainWindow();
  showMainWindow();
  buildTrayMenu();
  notify('New Meta AI account', `${profile.name} created. Sign in to Meta AI. Your other saved sessions remain untouched.`);
}

function switchMetaAccount() {
  if (!state.profiles.length) return;
  const current = state.profiles.findIndex((p) => p.id === state.activeProfileId);
  const next = state.profiles[(current + 1) % state.profiles.length];
  switchMetaAccountById(next.id);
}

function switchMetaAccountById(id) {
  if (!state.profiles.some((p) => p.id === id)) return;
  state.site = 'meta';
  switchProfile(id);
}

// ---- clipboard -> text file ----------------------------------------------
// Pasting a huge blob into chat can lock the renderer. This dumps the
// clipboard to a .txt instead, so it can be dragged into chat as a file.
function saveClipboardAsFile() {
  const text = clipboard.readText();
  if (!text) {
    notify('Clipboard is empty', 'Copy some text first, then use this again.');
    return;
  }
  const dir = path.join(app.getPath('documents'), 'Muse clips');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fp = path.join(dir, `clip-${stamp}.txt`);
  fs.writeFileSync(fp, text, 'utf8');
  const kb = Math.round(Buffer.byteLength(text, 'utf8') / 1024);
  notify(
    'Saved clipboard as text file',
    `${path.basename(fp)} (${kb} KB). Click to open its folder, then drag it into chat.`,
    () => shell.showItemInFolder(fp)
  );
}

// ---- permissions ----------------------------------------------------------------
// meta.ai's voice chat needs the microphone. Electron denies permission
// requests by default, so grant audio capture, but only on our two sites.
function isSiteAutomationAllowed(hostname) {
  const auto = state.automation;
  if (!auto.enabled) return false;
  if (auto.autoAllowAll) return true;
  if (!hostname) return false;
  const normalized = hostname.toLowerCase();
  return auto.sites[normalized] === true;
}

function isAutomationActionAllowed(actionKey, hostname) {
  if (!state.automation.enabled) return false;
  if (state.automation.autoAllowAll) return true;
  if (!isSiteAutomationAllowed(hostname)) return false;
  const normalized = String(hostname || '').toLowerCase();
  const siteRules = state.automation.siteActions[normalized];
  if (siteRules && siteRules[actionKey] !== undefined) return !!siteRules[actionKey];
  return state.automation.actions[actionKey] === true;
}

function notifyWebContentsAutomationChange() {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('automation-changed', state.automation);
    }
  }
}

function toggleAutomationMaster(forcedValue) {
  state.automation.enabled = typeof forcedValue === 'boolean' ? forcedValue : !state.automation.enabled;
  saveState();
  buildTrayMenu();
  notifyWebContentsAutomationChange();
  notify(
    state.automation.enabled ? 'Automation Active' : 'Automation Disabled',
    state.automation.enabled
      ? 'Auto-allow rules & shortcuts are active.'
      : 'Auto-allow features have been paused.'
  );
}

function setupPermissions(profileId) {
  const ses = session.fromPartition(partitionFor(profileId));
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    let url = '';
    try { url = webContents.getURL(); } catch { /* ignore */ }
    const ours = /^https:\/\/(www\.)?(muse\.ai|meta\.ai)(\/|$)/.test(url);

    let hostname = '';
    try { hostname = new URL(url).hostname; } catch { /* ignore */ }

    // Mic for voice chat, clipboard for the site's own copy buttons.
    let allowed = permission === 'media' || permission === 'audioCapture' ||
      permission === 'clipboard-read' || permission === 'clipboard-sanitized-write';

    if (state.automation.enabled && (permission === 'media' || permission === 'audioCapture')) {
      allowed = isAutomationActionAllowed('media_permissions', hostname);
    }

    callback(ours && allowed);
  });
}

// ---- microphone toggle ------------------------------------------------------
// The page owns its mic device, so the app can't pick it, but it can mute it:
// a tiny shim in the page's own JS world wraps getUserMedia, tracks the
// streams the site creates, and flips their audio tracks on/off.
const MIC_SHIM = `(() => {
  if (window.__museMic) return;
  const st = { muted: false, streams: new Set() };
  const apply = () => st.streams.forEach((s) => {
    try { s.getAudioTracks().forEach((t) => { t.enabled = !st.muted; }); } catch {}
  });
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (...args) => {
      const stream = await orig(...args);
      st.streams.add(stream);
      stream.getAudioTracks().forEach((t) => { t.enabled = !st.muted; });
      stream.addEventListener('inactive', () => st.streams.delete(stream));
      return stream;
    };
  }
  window.__museMic = {
    toggle: () => { st.muted = !st.muted; apply(); return st.muted; },
    get: () => st.muted,
  };
})();`;

function injectMicShim(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(MIC_SHIM).catch(() => {});
}

async function toggleMic() {
  const w = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!w) return;
  try {
    const muted = await w.webContents.executeJavaScript(
      '(() => { const m = window.__museMic; return m ? m.toggle() : null; })()'
    );
    if (muted === null || muted === undefined) {
      notify('Mic control not ready', 'The page is still loading. Try again in a moment.');
      return;
    }
    notify(muted ? 'Microphone muted' : 'Microphone live', muted ? 'Voice chat cannot hear you.' : 'Voice chat can hear you.');
  } catch (e) {
    notify('Mic toggle failed', String((e && e.message) || e));
  }
}

function toggleSpeaker() {
  const w = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!w) return;
  const muted = !w.webContents.isAudioMuted();
  w.webContents.setAudioMuted(muted);
  notify(muted ? 'App sound muted' : 'App sound on', muted ? 'You will not hear replies.' : 'You will hear replies.');
}

// ---- hotkey registration & settings -----------------------------------------
function registerHotkeys() {
  for (const [id, acc] of Object.entries(state.hotkeys)) {
    const handler = HOTKEY_ACTIONS[id];
    if (!handler || !acc) continue;
    try {
      if (!globalShortcut.register(acc, handler)) console.warn('hotkey register failed:', id, acc);
    } catch (e) { console.warn('hotkey register threw:', id, acc, e.message); }
  }
}

// Applies a new binding map from the settings window. Returns {ok} or {ok, error}.
function applyHotkeys(bindings) {
  const seen = {};
  for (const [id, acc] of Object.entries(bindings)) {
    if (!HOTKEY_ACTIONS[id]) return { ok: false, error: `Unknown action: ${id}` };
    if (!acc || !String(acc).trim()) return { ok: false, error: `Empty hotkey for "${HOTKEY_LABELS[id]}"` };
    const norm = String(acc).toLowerCase();
    if (seen[norm]) return { ok: false, error: `Duplicate hotkey: ${acc}` };
    seen[norm] = id;
  }
  globalShortcut.unregisterAll();
  for (const [id, acc] of Object.entries(bindings)) {
    let ok = false;
    try { ok = globalShortcut.register(acc, HOTKEY_ACTIONS[id]); } catch { ok = false; }
    if (!ok) {
      globalShortcut.unregisterAll();
      registerHotkeys(); // roll back to the previous working set
      return { ok: false, error: `Could not register ${acc} (taken by Windows or another app?)` };
    }
  }
  state.hotkeys = { ...bindings };
  saveState();
  buildTrayMenu();
  return { ok: true };
}

let hotkeyWindow = null;
function openHotkeySettings() {
  if (hotkeyWindow && !hotkeyWindow.isDestroyed()) { hotkeyWindow.focus(); return; }
  hotkeyWindow = new BrowserWindow({
    width: 460,
    height: 640,
    title: 'Customize hotkeys',
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload-settings.js') },
  });
  hotkeyWindow.loadFile(path.join(__dirname, 'hotkeys.html'));
  hotkeyWindow.on('closed', () => { hotkeyWindow = null; });
}

ipcMain.handle('hotkeys-get', () => ({
  bindings: { ...state.hotkeys },
  labels: { ...HOTKEY_LABELS },
  defaults: { ...DEFAULT_HOTKEYS },
}));
ipcMain.handle('hotkeys-set', (e, bindings) => applyHotkeys(bindings || {}));

// Automation IPC handlers
ipcMain.handle('automation-get', () => ({
  ...state.automation,
  currentSiteUrl: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : '',
}));

ipcMain.handle('automation-set', (e, updates) => {
  if (!updates || typeof updates !== 'object') return { ok: false };
  if (typeof updates.enabled === 'boolean') state.automation.enabled = updates.enabled;
  if (typeof updates.autoAllowAll === 'boolean') state.automation.autoAllowAll = updates.autoAllowAll;
  if (typeof updates.showOnScreenWidget === 'boolean') state.automation.showOnScreenWidget = updates.showOnScreenWidget;
  if (updates.actions && typeof updates.actions === 'object') {
    state.automation.actions = { ...state.automation.actions, ...updates.actions };
  }
  if (updates.sites && typeof updates.sites === 'object') {
    state.automation.sites = { ...updates.sites };
  }
  saveState();
  buildTrayMenu();
  notifyWebContentsAutomationChange();
  return { ok: true, state: state.automation };
});

ipcMain.handle('automation-toggle', () => {
  toggleAutomationMaster();
  return { ok: true, enabled: state.automation.enabled };
});

ipcMain.handle('automation-toggle-site', (e, hostname, enabled) => {
  if (!hostname) return { ok: false, error: 'No hostname provided' };
  const norm = hostname.toLowerCase();
  if (typeof enabled === 'boolean') {
    state.automation.sites[norm] = enabled;
  } else {
    const current = isSiteAutomationAllowed(norm);
    state.automation.sites[norm] = !current;
  }
  saveState();
  buildTrayMenu();
  notifyWebContentsAutomationChange();
  return { ok: true, allowed: isSiteAutomationAllowed(norm), sites: state.automation.sites };
});

ipcMain.handle('automation-set-site-action', (e, hostname, actionKey, enabled) => {
  if (!hostname || state.automation.actions[actionKey] === undefined) return { ok: false, error: 'Unknown site or action' };
  const norm = String(hostname).toLowerCase();
  state.automation.siteActions[norm] = { ...(state.automation.siteActions[norm] || {}), [actionKey]: !!enabled };
  saveState();
  buildTrayMenu();
  notifyWebContentsAutomationChange();
  return { ok: true, siteActions: state.automation.siteActions };
});

ipcMain.handle('automation-set-action', (e, actionKey, enabled) => {
  if (state.automation.actions[actionKey] !== undefined) {
    state.automation.actions[actionKey] = !!enabled;
    saveState();
    buildTrayMenu();
    notifyWebContentsAutomationChange();
    return { ok: true, actions: state.automation.actions };
  }
  return { ok: false, error: 'Unknown action' };
});

ipcMain.handle('open-settings', () => {
  openHotkeySettings();
  return { ok: true };
});
// Floating "Export chat" button in the page asks the main process to export.
ipcMain.on('muse-export-request', () => exportChat());

// ---- downloads & right-click menu -------------------------------------------
// Electron shows no context menu on its own, so links can only be clicked
// (navigating to them) rather than saved. This adds Save link/image as,
// copy link, and the standard edit items, plus real download handling.
function setupDownloadHandler(profileId) {
  const ses = session.fromPartition(partitionFor(profileId));
  ses.removeAllListeners('will-download');
  ses.on('will-download', (event, item) => {
    const fileName = item.getFilename() || 'download';
    item.setSaveDialogOptions({
      title: 'Save file',
      defaultPath: path.join(app.getPath('downloads'), fileName),
    });
    item.on('done', (e, state) => {
      if (state === 'completed') {
        notify('Download complete', `${fileName} saved. Click to open the folder.`, () =>
          shell.showItemInFolder(item.getSavePath())
        );
      } else if (state !== 'cancelled') {
        notify(`Download ${state}`, fileName);
      }
    });
  });
}

function attachContextMenu(win) {
  win.webContents.on('context-menu', (e, params) => {
    const menu = new Menu();
    if (params.linkURL) {
      const url = params.linkURL;
      menu.append(new MenuItem({ label: 'Save link as…', click: () => win.webContents.downloadURL(url) }));
      menu.append(new MenuItem({ label: 'Copy link address', click: () => clipboard.writeText(url) }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.hasImageContents && params.srcURL) {
      const src = params.srcURL;
      menu.append(new MenuItem({ label: 'Save image as…', click: () => win.webContents.downloadURL(src) }));
      menu.append(new MenuItem({ label: 'Copy image address', click: () => clipboard.writeText(src) }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.isEditable) {
      menu.append(new MenuItem({ role: 'cut' }));
      menu.append(new MenuItem({ role: 'copy' }));
      menu.append(new MenuItem({ role: 'paste' }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: 'copy' }));
    }
    if (menu.items.length > 0) menu.popup({ window: win });
  });
}

// ---- chat export ------------------------------------------------------------
// Reads the open conversation out of the page (user's own chat, saved to
// their own disk). Markdown is the primary format: every AI reads it and it
// stays human-readable. JSON for structured use, HTML for visual fidelity.
function roleLabel(role) {
  return role === 'user' ? 'User' : role === 'assistant' ? 'Assistant' : 'Unknown';
}

function exportMarkdown(data) {
  const lines = [
    `# ${data.title || 'Chat export'}`,
    '',
    `- Exported: ${data.scrapedAt}`,
    `- Site: ${data.url}`,
    `- Profile: ${activeProfile().name}`,
    `- Messages: ${data.messages.length}`,
    '',
    '---',
    '',
  ];
  for (const m of data.messages) {
    lines.push(`## ${roleLabel(m.role)}${m.timestamp ? ` (${m.timestamp})` : ''}`, '', m.text, '');
  }
  return lines.join('\n');
}

function exportJSON(data) {
  return JSON.stringify(
    {
      meta: {
        title: data.title,
        url: data.url,
        profile: activeProfile().name,
        scrapedAt: data.scrapedAt,
        messageCount: data.messages.length,
      },
      messages: data.messages,
    },
    null,
    2
  );
}

function escapeHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function exportHTML(data) {
  const bubbles = data.messages
    .map((m) => {
      const cls = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'unknown';
      return `<div class="msg ${cls}"><div class="role">${roleLabel(m.role)}${m.timestamp ? ` <span class="ts">${escapeHTML(m.timestamp)}</span>` : ''}</div><div class="text">${escapeHTML(m.text).replace(/\n/g, '<br>')}</div></div>`;
    })
    .join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHTML(data.title || 'Chat export')}</title><style>
body{font-family:system-ui,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;background:#141414;color:#e8e8e8}
.msg{margin:1rem 0;padding:.75rem 1rem;border-radius:12px;white-space:normal}
.msg.user{background:#1e3a5f;margin-left:15%}
.msg.assistant{background:#242424;margin-right:15%}
.msg.unknown{background:#2a2a2a}
.role{font-size:.75rem;opacity:.7;margin-bottom:.4rem}
.ts{opacity:.6}
.text{line-height:1.5;overflow-wrap:anywhere}
.meta{opacity:.6;font-size:.8rem;margin-bottom:2rem}
</style></head><body><h1>${escapeHTML(data.title || 'Chat export')}</h1><div class="meta">Exported ${escapeHTML(data.scrapedAt)} from ${escapeHTML(data.url)} (${data.messages.length} messages)</div>${bubbles}</body></html>`;
}

async function exportChat() {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) {
    notify('Nothing to export', 'Open Muse first, then export the chat.');
    return;
  }
  let data = null;
  try {
    data = await win.webContents.executeJavaScript(
      'window.museExport ? window.museExport.scrape() : null'
    );
  } catch {
    data = null;
  }
  if (!data || !data.ok || !data.messages || !data.messages.length) {
    notify(
      'Export found no messages',
      'Could not detect chat messages on this page. Scroll the chat into view and try again.'
    );
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const { filePath, canceled } = await dialog.showSaveDialog(win, {
    title: 'Export chat',
    defaultPath: `muse-chat-${stamp}.md`,
    filters: [
      { name: 'Markdown (best for sharing with AIs)', extensions: ['md'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'HTML', extensions: ['html'] },
    ],
  });
  if (canceled || !filePath) return;
  const ext = path.extname(filePath).toLowerCase();
  const content =
    ext === '.json' ? exportJSON(data) : ext === '.html' ? exportHTML(data) : exportMarkdown(data);
  fs.writeFileSync(filePath, content, 'utf8');
  notify(
    'Chat exported',
    `${data.messages.length} messages saved to ${path.basename(filePath)}. Click to open the folder.`,
    () => shell.showItemInFolder(filePath)
  );
}

// ---- portable self-update -----------------------------------------------------
// electron-updater doesn't support the portable target, so the portable build
// updates itself: check the GitHub releases feed, download the new portable
// exe in the background, and swap it in on restart via a tiny detached
// PowerShell helper. A .bak of the previous version is kept beside the exe.
const UPDATE_REPO = 'whxjwksjs/muse-windows';

function cmpVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function checkForUpdates(manual) {
  if (!app.isPackaged) return; // dev mode: never self-update
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'muse-windows', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`release feed returned ${res.status}`);
    const rel = await res.json();
    const latest = String(rel.tag_name || rel.name || '').replace(/^v/i, '');
    if (!latest || cmpVersions(latest, app.getVersion()) <= 0) {
      if (manual) notify('No updates', 'You are on the latest version.');
      return;
    }
    if (pendingUpdate && pendingUpdate.version === latest) return; // already downloaded
    const asset = (rel.assets || []).find((a) => /^Muse-Portable-.*\.exe$/i.test(a.name || ''));
    if (!asset) {
      if (manual) notify('Update found', `v${latest} is out, but the release has no portable exe attached.`);
      return;
    }
    notify('Downloading update', `Muse v${latest} is downloading in the background.`);
    const dl = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'muse-windows' } });
    if (!dl.ok) throw new Error(`download returned ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length < 1024 || buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error('downloaded file is not a valid exe');
    const dest = path.join(app.getPath('temp'), asset.name);
    await fs.promises.writeFile(dest, buf);
    pendingUpdate = { version: latest, filePath: dest };
    updateDownloaded = true;
    buildTrayMenu();
    notify('Update ready', `Muse v${latest} downloaded. Restart from the tray menu to install it.`);
  } catch (e) {
    if (manual) notify('Update check failed', String((e && e.message) || e));
  }
}

function buildUpdateScript(currentExe, newExe) {
  const q = (s) => s.replace(/'/g, "''");
  return [
    `$pidToWait = ${process.pid}`,
    `$current = '${q(currentExe)}'`,
    `$new = '${q(newExe)}'`,
    `try { Wait-Process -Id $pidToWait -ErrorAction Stop } catch {}`,
    `try {`,
    `  Copy-Item -LiteralPath $current -Destination ($current + '.bak') -Force`,
    `  Move-Item -LiteralPath $new -Destination $current -Force`,
    `  Start-Process -FilePath $current`,
    `} catch {}`,
  ].join('\r\n');
}

function canWriteBesideExe() {
  try {
    const probe = path.join(path.dirname(process.execPath), '.muse-write-test');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function installUpdateAndRestart() {
  if (!pendingUpdate) return;
  if (!canWriteBesideExe()) {
    notify('Update failed', 'The app folder is not writable. Download the new version from the GitHub releases page instead.');
    return;
  }
  const scriptPath = path.join(app.getPath('temp'), 'muse-update.ps1');
  try {
    fs.writeFileSync(scriptPath, buildUpdateScript(process.execPath, pendingUpdate.filePath));
  } catch (e) {
    notify('Update failed', 'Could not write the updater script: ' + String((e && e.message) || e));
    return;
  }
  try {
    require('child_process').spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      detached: true, stdio: 'ignore',
    }).unref();
  } catch (e) {
    notify('Update failed', String((e && e.message) || e));
    return;
  }
  app.quitting = true;
  app.quit();
}

function setupAutoUpdate() {
  // First check shortly after launch, then every 6 hours. Manual check lives in the tray menu.
  setTimeout(() => checkForUpdates(false), 30_000);
  setInterval(() => checkForUpdates(false), 6 * 3600_000);
}

// ---- tray -----------------------------------------------------------------
const prettyHotkey = (acc) => String(acc || '').replace('CommandOrControl', 'Ctrl');
function buildTrayMenu() {
  if (!tray) return;
  const otherSite = state.site === 'muse' ? SITES.meta : SITES.muse;
  const loginSettings = app.getLoginItemSettings();

  const profileItems = state.profiles.map((p) => ({
    label: p.name,
    type: 'radio',
    checked: p.id === state.activeProfileId,
    click: () => switchProfile(p.id),
  }));

  let currentHostname = 'muse.ai';
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      currentHostname = new URL(mainWindow.webContents.getURL()).hostname;
    }
  } catch { /* ignore */ }

  const metaAccounts = state.profiles.map((p) => ({
    label: p.name,
    type: 'radio',
    checked: p.id === state.activeProfileId && state.site === 'meta',
    click: () => switchMetaAccountById(p.id),
  }));

  const template = [
    { label: 'Open Muse', click: showMainWindow },
    { label: `Quick chat  (${prettyHotkey(state.hotkeys.quick)})`, click: toggleQuickWindow },
    { label: `Switch to ${otherSite.name}  (${prettyHotkey(state.hotkeys.site)})`, click: toggleSite },
    {
      label: 'Meta AI Accounts',
      submenu: [
        ...metaAccounts,
        { type: 'separator' },
        { label: `Next Meta AI account  (${prettyHotkey(state.hotkeys.metaAccount)})`, click: switchMetaAccount },
        { label: 'Add Meta AI account…', click: addMetaAccount },
      ],
    },
    { type: 'separator' },
    {
      label: 'Automation / Auto-Allow',
      submenu: [
        {
          label: `Master Automation (${prettyHotkey(state.hotkeys.automation)})`,
          type: 'checkbox',
          checked: state.automation.enabled,
          click: () => toggleAutomationMaster(),
        },
        {
          label: 'Auto-Allow All Actions',
          type: 'checkbox',
          checked: state.automation.autoAllowAll,
          click: (item) => {
            state.automation.autoAllowAll = item.checked;
            saveState();
            buildTrayMenu();
            notifyWebContentsAutomationChange();
          },
        },
        {
          label: `Always allow on ${currentHostname}`,
          type: 'checkbox',
          checked: isSiteAutomationAllowed(currentHostname),
          click: (item) => {
            state.automation.sites[currentHostname.toLowerCase()] = item.checked;
            saveState();
            buildTrayMenu();
            notifyWebContentsAutomationChange();
          },
        },
        { type: 'separator' },
        {
          label: 'Show On-Screen Widget',
          type: 'checkbox',
          checked: state.automation.showOnScreenWidget,
          click: (item) => {
            state.automation.showOnScreenWidget = item.checked;
            saveState();
            buildTrayMenu();
            notifyWebContentsAutomationChange();
          },
        },
        { label: 'Settings & Keybinds…', click: openHotkeySettings },
      ],
    },
    { type: 'separator' },
    {
      label: `Profile: ${activeProfile().name}`,
      submenu: [
        ...profileItems,
        { type: 'separator' },
        { label: 'Add profile…', click: addProfile },
        { label: `Sign out of ${currentSite().name}…`, click: signOut },
      ],
    },
    { label: 'Save clipboard text as .txt', click: saveClipboardAsFile },
    { label: `Export this chat as file…  (${prettyHotkey(state.hotkeys.export)})`, click: exportChat },
    { type: 'separator' },
    { label: `Mute / unmute microphone  (${prettyHotkey(state.hotkeys.mic)})`, click: toggleMic },
    { label: `Mute / unmute app sound  (${prettyHotkey(state.hotkeys.speaker)})`, click: toggleSpeaker },
    { label: 'Customize hotkeys & settings…', click: openHotkeySettings },
    { type: 'separator' },
    {
      label: 'Run on startup',
      type: 'checkbox',
      checked: loginSettings.openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { label: 'Check for updates', click: () => checkForUpdates(true) },
    ...(updateDownloaded
      ? [{ label: 'Restart and install update', click: installUpdateAndRestart }]
      : []),
    { type: 'separator' },
    {
      label: 'Quit Muse',
      click: () => {
        app.quitting = true;
        app.quit();
      },
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
  } catch {
    icon = undefined;
  }
  tray = new Tray(icon);
  tray.setToolTip('Muse');
  buildTrayMenu();
  tray.on('click', showMainWindow);
}

// ---- app lifecycle ----------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    createMainWindow();
    createTray();
    registerHotkeys();
    state.profiles.forEach((p) => { setupDownloadHandler(p.id); setupPermissions(p.id); });
    setupAutoUpdate();
  });

  app.on('window-all-closed', () => {
    // Keep running in the tray; quit explicitly from the tray menu.
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
