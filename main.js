const { app, BrowserWindow, ipcMain, session, screen, globalShortcut } = require('electron');
const { exec, execSync, spawn } = require('child_process');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const ELEVATION_RELAUNCH_FLAG = '--securepro-elevated-relaunch';

function quotePSSingle(str) {
  return String(str).replace(/'/g, "''");
}

function isRunningAsAdminWin() {
  if (process.platform !== 'win32') return true;
  try {
    const result = execSync(
      'powershell -NoProfile -NonInteractive -Command "[bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"',
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim().toLowerCase();
    return result === 'true';
  } catch (_) {
    return false;
  }
}

function ensureAdminOnWindows() {
  if (process.platform !== 'win32') return false;
  if (!app.isPackaged) return false;
  if (isRunningAsAdminWin()) return false;

  // Avoid infinite loop if elevation was denied or failed.
  if (process.argv.includes(ELEVATION_RELAUNCH_FLAG)) {
    console.error('[SECURITY] Administrator permission is required to run SecurePro.');
    app.quit();
    return true;
  }

  const exePath = process.execPath;
  const relaunchArgs = process.argv
    .slice(1)
    .filter(arg => arg !== ELEVATION_RELAUNCH_FLAG)
    .map(arg => {
      if (arg.startsWith('-')) return arg;
      if (path.isAbsolute(arg)) return arg;
      return path.resolve(process.cwd(), arg);
    });
  relaunchArgs.push(ELEVATION_RELAUNCH_FLAG);

  const argList = relaunchArgs.length
    ? ` -ArgumentList @(${relaunchArgs.map(arg => `'${quotePSSingle(arg)}'`).join(',')})`
    : '';

  const psCommand = `Start-Process -FilePath '${quotePSSingle(exePath)}'${argList} -WorkingDirectory '${quotePSSingle(process.cwd())}' -Verb RunAs`;

  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
  } catch (error) {
    console.error('[SECURITY] Failed to relaunch as Administrator:', error.message);
  }

  app.quit();
  return true;
}

// ── AUTO-UPDATER CONFIGURATION ───────────────────────────────────────────────
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function setupAutoUpdater() {
  try { autoUpdater.checkForUpdates(); } catch (e) { /* running in dev mode */ }

  autoUpdater.on('update-available', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', { version: info.version, releaseNotes: info.releaseNotes || '' });
    }
  });
  autoUpdater.on('update-not-available', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-not-available');
  });
  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-download-progress', {
        percent: Math.round(progress.percent), transferred: progress.transferred,
        total: progress.total, bytesPerSecond: progress.bytesPerSecond
      });
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-downloaded', { version: info.version });
  });
  autoUpdater.on('error', (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-error', { message: err.message });
  });
}

ipcMain.on('start-update-download', () => {
  try { autoUpdater.downloadUpdate(); } catch (e) { console.warn('Update download failed:', e.message); }
});
ipcMain.on('install-update-now', () => {
  destroyBlackoutWindows();
  autoUpdater.quitAndInstall(false, true);
});
ipcMain.on('check-for-updates', () => {
  try { autoUpdater.checkForUpdates(); } catch (e) { /* dev mode */ }
});


let mainWindow;
let blackoutWindows = [];
let processMonitorInterval = null;
let focusEnforcerInterval = null;
let examActive = false; // Track whether exam is in progress

// Banned process list — executable names (without .exe on Windows)
const BANNED_PROCESSES = [
  'obs', 'obs64', 'obs32', 'snippingtool', 'screensketch',
  'teamviewer', 'anydesk', 'discord', 'whatsapp',
  'chrome', 'firefox', 'brave', 'opera',
  'zoom', 'skype', 'telegram', 'slack',
  'sharex', 'lightshot', 'greenshot', 'screenrec',
  'vmware', 'virtualbox', 'parsec', 'rustdesk'
];

// Process names to kill on Windows (exe filenames)
const KILL_TARGETS_WIN = [
  'obs.exe', 'obs64.exe', 'obs32.exe', 'snippingtool.exe', 'screensketch.exe',
  'teamviewer.exe', 'anydesk.exe', 'discord.exe', 'whatsapp.exe',
  'chrome.exe', 'firefox.exe', 'brave.exe', 'opera.exe',
  'zoom.exe', 'skype.exe', 'telegram.exe', 'slack.exe',
  'sharex.exe', 'lightshot.exe', 'greenshot.exe', 'screenrec.exe',
  'vmware.exe', 'virtualboxvm.exe', 'parsec.exe', 'rustdesk.exe'
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function execAsync(command, options = {}) {
  return new Promise(resolve => {
    exec(command, options, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function parseTasklistImageNames(stdout) {
  return (stdout || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      if (line.startsWith('"')) {
        const endIdx = line.indexOf('",');
        if (endIdx > 1) return line.slice(1, endIdx);
      }
      return line.split(',')[0].replace(/^"|"$/g, '');
    })
    .filter(Boolean);
}

function getBannedProcessNamesFromOutput(processOutput) {
  const running = (processOutput || '').toLowerCase();
  return [...new Set(BANNED_PROCESSES.filter(proc => running.includes(proc.toLowerCase())))];
}

async function getRunningBannedProcesses() {
  const cmd = process.platform === 'win32' ? 'tasklist /FO CSV /NH' : 'ps aux';
  const { error, stdout } = await execAsync(cmd, { timeout: 10000, maxBuffer: 1024 * 1024 });
  if (error || !stdout) return [];
  return getBannedProcessNamesFromOutput(stdout);
}

// ── KILL BANNED PROCESSES ──────────────────────────────────────────────────
async function killBannedProcesses(passes = 3) {
  const isWin = process.platform === 'win32';
  const totalPasses = Math.max(1, passes);

  for (let pass = 0; pass < totalPasses; pass++) {
    if (isWin) {
      const { stdout } = await execAsync('tasklist /FO CSV /NH', { timeout: 10000, maxBuffer: 1024 * 1024 });
      const discoveredTargets = parseTasklistImageNames(stdout).filter(name =>
        BANNED_PROCESSES.some(proc => name.toLowerCase().includes(proc.toLowerCase()))
      );
      const killTargets = [...new Set([...KILL_TARGETS_WIN, ...discoveredTargets])];
      await Promise.all(killTargets.map(proc =>
        execAsync(`taskkill /f /t /im "${proc}"`, { timeout: 10000 })
      ));
    } else {
      await Promise.all(BANNED_PROCESSES.map(proc =>
        execAsync(`pkill -9 -f "${proc}"`, { timeout: 10000 })
      ));
    }

    if (pass < totalPasses - 1) await sleep(450);
  }

  console.log('[SECURITY] Terminating all banned background processes...');
}

// IPC: renderer requests process kill (called before exam starts)
ipcMain.on('kill-banned-processes', async () => {
  await killBannedProcesses(3);
});

ipcMain.handle('kill-banned-processes-and-wait', async () => {
  await killBannedProcesses(3);
  const remaining = await getRunningBannedProcesses();
  return { remaining };
});

// ── GLOBAL SHORTCUTS (block Alt+Tab, Win+D, trackpad gestures etc.) ────────
const EXAM_BLOCKED_SHORTCUTS = [
  'Alt+Tab', 'Alt+Shift+Tab',
  'Super+Tab', 'Super+Shift+Tab',   // Win+Tab (Task View)
  'Super+D',                         // Show Desktop
  'Super+M',                         // Minimize all
  'Super+H',                         // Hide windows
  'Super+L',                         // Lock screen
  'Control+Super+Left',              // Virtual desktop left (trackpad 4-finger)
  'Control+Super+Right',             // Virtual desktop right
  'Control+Super+Up',                // Task view
  'Control+Super+Down',              // Show desktop
  'Control+Escape',                  // Start menu
  'Alt+Escape',                      // Cycle windows
  'Alt+F4',                          // Close window
  'Super+E'                          // File Explorer
];

function registerExamShortcuts() {
  EXAM_BLOCKED_SHORTCUTS.forEach(shortcut => {
    try {
      globalShortcut.register(shortcut, () => {
        // Refocus our app instead of switching
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.focus();
          mainWindow.moveTop();
        }
      });
    } catch (e) {
      // Some shortcuts can't be registered (e.g. already taken by OS)
      console.warn('[SHORTCUTS] Could not register:', shortcut, e.message);
    }
  });
  console.log('[SECURITY] Global exam shortcuts registered (Alt+Tab, Win+D, gestures, etc.)');
}

function unregisterExamShortcuts() {
  globalShortcut.unregisterAll();
  console.log('[SECURITY] Global shortcuts released');
}

function startFocusEnforcer() {
  if (focusEnforcerInterval) clearInterval(focusEnforcerInterval);
  focusEnforcerInterval = setInterval(() => {
    if (!examActive || !mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    if (!mainWindow.isFocused()) {
      mainWindow.focus();
      mainWindow.moveTop();
    }
    if (!mainWindow.isAlwaysOnTop()) mainWindow.setAlwaysOnTop(true, 'screen-saver');
    if (!mainWindow.isKiosk()) mainWindow.setKiosk(true);
    if (!mainWindow.isFullScreen()) mainWindow.setFullScreen(true);
  }, 150);
}

function stopFocusEnforcer() {
  if (!focusEnforcerInterval) return;
  clearInterval(focusEnforcerInterval);
  focusEnforcerInterval = null;
}

// ── BLACKOUT WINDOW MANAGEMENT ─────────────────────────────────────────────
function createBlackoutWindows() {
  destroyBlackoutWindows();

  const displays = screen.getAllDisplays();
  for (const display of displays) {
    const { x, y, width, height } = display.bounds;
    const win = new BrowserWindow({
      x, y, width, height,
      frame: false,
      transparent: false,
      backgroundColor: '#000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      closable: false,
      hasShadow: false,
      webPreferences: { nodeIntegration: false }
    });
    win.loadURL('data:text/html,<html><body style="margin:0;background:#000;width:100vw;height:100vh;"></body></html>');
    win.setIgnoreMouseEvents(true);
    win.showInactive();
    blackoutWindows.push(win);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.focus();
  }
}

function destroyBlackoutWindows() {
  for (const win of blackoutWindows) {
    if (!win.isDestroyed()) win.destroy();
  }
  blackoutWindows = [];

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(false);
  }
}

function createWindow() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => { callback(true); });
  session.defaultSession.setPermissionCheckHandler(() => true);

  mainWindow = new BrowserWindow({
    fullscreen: false,
    kiosk: false,
    frame: true,
    alwaysOnTop: false,
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: false
    }
  });

  mainWindow.maximize();
  mainWindow.loadFile('index.html');

  mainWindow.on('close', () => {
    unregisterExamShortcuts();
    stopFocusEnforcer();
    destroyBlackoutWindows();
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // ── BLOCK KEYBOARD SHORTCUTS IN RENDERER ────────────────────────────────
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const k = input.key.toLowerCase();
    const inExam = examActive;
    if (
      (input.control && k === 'w') ||
      (input.control && k === 'q') ||
      (input.alt && k === 'f4') ||
      (input.alt && k === 'tab') ||
      (input.meta && k === 'tab') ||
      k === 'f11' || k === 'f12' ||
      (input.control && input.shift && (k === 'i' || k === 'j' || k === 'c')) ||
      (input.control && input.shift && k === 'escape') ||
      (input.meta && (k === 'h' || k === 'd' || k === 'm' || k === 'e')) ||
      (inExam && k === 'escape') ||
      (input.meta && input.shift && (k === '3' || k === '4' || k === '5')) ||
      (input.control && input.meta && (k === 'arrowleft' || k === 'arrowright'))
    ) {
      event.preventDefault();
    }
  });

  // ── KEEP FOCUS DURING EXAM ───────────────────────────────────────────────
  mainWindow.on('blur', () => {
    if (examActive) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.focus();
          mainWindow.moveTop();
        }
      }, 80);
    }
  });

  // Prevent minimize during exam
  mainWindow.on('minimize', () => {
    if (examActive) {
      mainWindow.restore();
      mainWindow.focus();
    }
  });

  // ── EXAM CONTROL IPC ────────────────────────────────────────────────────
  ipcMain.on('show-blackout', async () => {
    examActive = true;

    // 1. Kill all banned processes immediately
    await killBannedProcesses(3);

    // 2. Block OS-level keyboard shortcuts & trackpad gestures
    registerExamShortcuts();
    startFocusEnforcer();

    // 3. Black out all other screens
    createBlackoutWindows();

    // 4. Lock the window into kiosk fullscreen
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setFullScreen(true);
      mainWindow.setKiosk(true);
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      mainWindow.focus();

      // Retry in case OS delays the fullscreen
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (!mainWindow.isFullScreen()) mainWindow.setFullScreen(true);
          if (!mainWindow.isKiosk()) mainWindow.setKiosk(true);
          mainWindow.focus();
        }
      }, 600);
    }
    console.log('[EXAM] Lockdown activated — blackout, kiosk, global shortcuts, process kill');
  });

  ipcMain.on('hide-blackout', () => {
    examActive = false;

    // Unregister all global shortcuts
    unregisterExamShortcuts();
    stopFocusEnforcer();

    destroyBlackoutWindows();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setKiosk(false);
      mainWindow.setFullScreen(false);
      mainWindow.setAlwaysOnTop(false);
      mainWindow.setVisibleOnAllWorkspaces(false);
    }
    console.log('[EXAM] Lockdown deactivated');
  });

  // Update blackout on display changes
  screen.on('display-added', () => { if (blackoutWindows.length > 0) createBlackoutWindows(); });
  screen.on('display-removed', () => { if (blackoutWindows.length > 0) createBlackoutWindows(); });

  // ── MULTIPLE MONITOR DETECTION ──────────────────────────────────────────
  function checkDisplays() {
    const displays = screen.getAllDisplays();
    if (displays.length > 1) {
      mainWindow.webContents.send('multiple-displays-detected', {
        count: displays.length,
        displays: displays.map(d => ({ id: d.id, label: d.label || 'Display ' + d.id, bounds: d.bounds, size: `${d.bounds.width}x${d.bounds.height}` }))
      });
    } else {
      mainWindow.webContents.send('displays-ok');
    }
  }
  mainWindow.webContents.on('did-finish-load', () => {
    checkDisplays();
    setInterval(checkDisplays, 30000);
    setTimeout(() => setupAutoUpdater(), 5000);
  });
  screen.on('display-added', checkDisplays);
  screen.on('display-removed', checkDisplays);

  // ── PROCESS MONITOR ─────────────────────────────────────────────────────
  ipcMain.on('start-process-monitor', () => {
    if (processMonitorInterval) clearInterval(processMonitorInterval);
    processMonitorInterval = setInterval(scanProcesses, 30000); // Every 30s
    scanProcesses();
  });

  ipcMain.on('stop-process-monitor', () => {
    if (processMonitorInterval) { clearInterval(processMonitorInterval); processMonitorInterval = null; }
  });
}

function scanProcesses() {
  const cmd = process.platform === 'win32' ? 'tasklist /FO CSV /NH' : 'ps aux';
  exec(cmd, { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    if (err || !stdout) return;
    const found = getBannedProcessNamesFromOutput(stdout);
    if (found.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
      killBannedProcesses(1).catch(() => { /* ignore kill race errors */ });
      mainWindow.webContents.send('banned-process-detected', {
        processes: found,
        timestamp: Date.now()
      });
    }
  });
}

ipcMain.on('quit-app', () => {
  unregisterExamShortcuts();
  stopFocusEnforcer();
  destroyBlackoutWindows();
  app.quit();
});

app.on('before-quit', () => {
  unregisterExamShortcuts();
  stopFocusEnforcer();
  destroyBlackoutWindows();
});

app.whenReady().then(() => {
  if (ensureAdminOnWindows()) return;
  createWindow();
});

app.on('window-all-closed', () => {
  unregisterExamShortcuts();
  stopFocusEnforcer();
  destroyBlackoutWindows();
  if (process.platform !== 'darwin') app.quit();
});
