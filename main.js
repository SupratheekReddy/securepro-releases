const { app, BrowserWindow, ipcMain, session, screen } = require('electron');
const { exec } = require('child_process');
const { autoUpdater } = require('electron-updater');

// ── AUTO-UPDATER CONFIGURATION ───────────────────────────────────────────────
autoUpdater.autoDownload = false;       // Don't silently download — let user decide
autoUpdater.autoInstallOnAppQuit = true; // Install after next quit if downloaded

function setupAutoUpdater() {
  // Check for updates (only works in packaged app, not during npm start)
  try { autoUpdater.checkForUpdates(); } catch (e) { /* running in dev mode */ }

  autoUpdater.on('update-available', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', {
        version: info.version,
        releaseNotes: info.releaseNotes || ''
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-not-available');
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-download-progress', {
        percent: Math.round(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded', { version: info.version });
    }
  });

  autoUpdater.on('error', (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-error', { message: err.message });
    }
  });
}

// IPC: renderer asks to start downloading the update
ipcMain.on('start-update-download', () => {
  try { autoUpdater.downloadUpdate(); } catch (e) { console.warn('Update download failed:', e.message); }
});

// IPC: renderer asks to install now and restart
ipcMain.on('install-update-now', () => {
  destroyBlackoutWindows();
  autoUpdater.quitAndInstall(false, true);
});

// IPC: renderer manually triggers a check
ipcMain.on('check-for-updates', () => {
  try { autoUpdater.checkForUpdates(); } catch (e) { /* dev mode */ }
});


let mainWindow;
let blackoutWindows = []; // One per display
let processMonitorInterval = null;

// Banned process list (case-insensitive partial match)
const BANNED_PROCESSES = [
  'obs', 'obs64', 'obs32', 'snippingtool', 'screensketch',
  'teamviewer', 'anydesk', 'discord', 'whatsapp',
  'chrome', 'firefox', 'brave', 'opera',
  'zoom', 'skype', 'telegram', 'slack',
  'sharex', 'lightshot', 'greenshot', 'screenrec',
  'vmware', 'virtualbox', 'parsec', 'rustdesk'
];

// ── BLACKOUT WINDOW MANAGEMENT ─────────────────────────────────────────────
function createBlackoutWindows() {
  // Destroy any existing blackout windows first
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

    // Load a fully black page
    win.loadURL('data:text/html,<html><body style="margin:0;background:#000;width:100vw;height:100vh;"></body></html>');
    win.setIgnoreMouseEvents(true); // Clicks pass through to our main app
    win.showInactive();
    blackoutWindows.push(win);
  }

  // After blackout windows are up, bring main window above them
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver'); // highest level
    mainWindow.focus();
  }
}

function destroyBlackoutWindows() {
  for (const win of blackoutWindows) {
    if (!win.isDestroyed()) win.destroy();
  }
  blackoutWindows = [];

  // Return main window to normal z-level
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(false);
  }
}

function createWindow() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return true;
  });

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
      devTools: false // Disable devtools in prod
    }
  });

  mainWindow.maximize();
  mainWindow.loadFile('index.html');

  // ── CLEAN UP BLACKOUT IF THE WINDOW IS CLOSED ANY WAY ───────────────────
  // Covers: user clicks X, Task Manager kills it, alt+F4, etc.
  mainWindow.on('close', () => {
    destroyBlackoutWindows();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // BLOCK KEYBOARD SHORTCUTS
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const k = input.key.toLowerCase();
    if (
      (input.control && k === 'w') ||
      (input.control && k === 'q') ||
      (input.alt && k === 'f4') ||
      k === 'f11' || k === 'f12' ||
      (input.control && input.shift && (k === 'i' || k === 'j' || k === 'c'))
    ) {
      event.preventDefault();
    }
  });

  // === SCREEN BLACKOUT IPC ===
  ipcMain.on('show-blackout', () => {
    createBlackoutWindows();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setFullScreen(true);
      mainWindow.setKiosk(true); // Locks down app, forces fullscreen, hides taskbar
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
    console.log('[BLACKOUT] Screen blackout activated along with Kiosk fullscreen');
  });

  ipcMain.on('hide-blackout', () => {
    destroyBlackoutWindows();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setKiosk(false); // Remove fullscreen lock when exam ends
      mainWindow.setFullScreen(false);
      mainWindow.setAlwaysOnTop(false);
    }
    console.log('[BLACKOUT] Screen blackout deactivated');
  });

  // Update blackout coverage if displays change during exam
  screen.on('display-added', () => {
    if (blackoutWindows.length > 0) createBlackoutWindows(); // Re-create for new display
  });
  screen.on('display-removed', () => {
    if (blackoutWindows.length > 0) createBlackoutWindows();
  });

  // === PHASE 1: MULTIPLE MONITOR DETECTION ===
  function checkDisplays() {
    const displays = screen.getAllDisplays();
    if (displays.length > 1) {
      mainWindow.webContents.send('multiple-displays-detected', {
        count: displays.length,
        displays: displays.map(d => ({
          id: d.id,
          label: d.label || 'Display ' + d.id,
          bounds: d.bounds,
          size: `${d.bounds.width}x${d.bounds.height}`
        }))
      });
    } else {
      mainWindow.webContents.send('displays-ok');
    }
  }

  // Check on load and every 30 seconds
  mainWindow.webContents.on('did-finish-load', () => {
    checkDisplays();
    setInterval(checkDisplays, 30000);
    // Check for updates 5 seconds after launch (gives the window time to render first)
    setTimeout(() => setupAutoUpdater(), 5000);
  });

  // Listen for display changes
  screen.on('display-added', checkDisplays);
  screen.on('display-removed', checkDisplays);

  // === PHASE 1: RUNNING PROCESS MONITOR ===
  ipcMain.on('start-process-monitor', () => {
    if (processMonitorInterval) clearInterval(processMonitorInterval);
    processMonitorInterval = setInterval(scanProcesses, 60000);
    scanProcesses(); // Run immediately
  });

  ipcMain.on('stop-process-monitor', () => {
    if (processMonitorInterval) { clearInterval(processMonitorInterval); processMonitorInterval = null; }
  });
}

function scanProcesses() {
  const cmd = process.platform === 'win32' ? 'tasklist /FO CSV /NH' : 'ps aux';
  exec(cmd, { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    if (err || !stdout) return;
    const running = stdout.toLowerCase();
    const found = [];
    BANNED_PROCESSES.forEach(proc => {
      if (running.includes(proc.toLowerCase())) {
        found.push(proc);
      }
    });
    if (found.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('banned-process-detected', {
        processes: [...new Set(found)],
        timestamp: Date.now()
      });
    }
  });
}

ipcMain.on('quit-app', () => {
  destroyBlackoutWindows();
  app.quit();
});

// Always destroy blackout windows before the process exits
app.on('before-quit', () => {
  destroyBlackoutWindows();
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  destroyBlackoutWindows();
  if (process.platform !== 'darwin') app.quit();
});
