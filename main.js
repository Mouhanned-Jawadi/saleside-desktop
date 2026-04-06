const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

// ─── Recall Desktop Recording SDK ────────────────────────────────────────────
let RecallAiSdk = null;
try {
  RecallAiSdk = require('@recallai/desktop-sdk');
} catch (err) {
  console.warn('[SDK] @recallai/desktop-sdk not installed — desktop recording disabled:', err.message);
}

// Config
const PORT = 3000;
const API_URL = 'https://saleside-back-20-production.up.railway.app/';
const PROXY_PATHS = ['/api', '/auth', '/launch-bot', '/socket.io'];

let mainWindow;
let server;

// ─── SDK State ────────────────────────────────────────────────────────────────
/** Most recently detected meeting window, or null if none is active. */
let currentDetectedMeeting = null;
/** WindowId of the currently active recording, or null when idle. */
let currentRecordingWindowId = null;
/** Whether the SDK is actively recording right now. */
let sdkIsRecording = false;

function initDesktopSdk() {
  if (!RecallAiSdk) return;

  try {
    RecallAiSdk.init({ apiUrl: 'https://us-west-2.recall.ai' });
    console.log('[SDK] Initialized with us-west-2 region');
  } catch (err) {
    console.error('[SDK] Failed to initialize:', err);
    return;
  }

  // ── Meeting detection ───────────────────────────────────────────────────────
  RecallAiSdk.addEventListener('meeting-detected', (evt) => {
    const { window: meetingWindow } = evt;
    console.log('[SDK] Meeting detected:', meetingWindow);

    currentDetectedMeeting = {
      id: meetingWindow.id,
      title: meetingWindow.title || '',
      platform: meetingWindow.platform || 'unknown',
    };

    // Notify the renderer if the window is already open
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sdk:meetingDetected', currentDetectedMeeting);
    }
  });

  // ── SDK state transitions ───────────────────────────────────────────────────
  RecallAiSdk.addEventListener('sdk-state-change', (evt) => {
    const stateCode = evt?.sdk?.state?.code || 'unknown';
    console.log('[SDK] State change:', stateCode);

    if (stateCode === 'recording') {
      sdkIsRecording = true;
    } else if (stateCode === 'idle') {
      sdkIsRecording = false;
      currentRecordingWindowId = null;
      currentDetectedMeeting = null;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sdk:stateChange', { code: stateCode });
    }
  });

  // ── Recording ended ─────────────────────────────────────────────────────────
  RecallAiSdk.addEventListener('recording-ended', (evt) => {
    const windowId = evt?.window?.id ?? null;
    console.log('[SDK] Recording ended for window:', windowId);
    sdkIsRecording = false;
    currentRecordingWindowId = null;
    currentDetectedMeeting = null;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sdk:recordingEnded', { windowId });
    }
  });

  // ── Real-time transcript events (desktop_sdk_callback) ─────────────────────
  // These arrive faster than the webhook path and are the primary transcript
  // delivery mechanism for the desktop app.
  RecallAiSdk.addEventListener('realtime-event', (evt) => {
    const eventType = evt?.event;
    if (!eventType) return;

    if (eventType === 'transcript.data' || eventType === 'transcript.partial_data') {
      const words = evt?.data?.words || [];
      const text = words.map(w => w.text || '').join(' ').trim();
      const participant = evt?.data?.participant || {};
      const speakerName = participant.name || String(participant.id || 'Unknown');
      const isFinal = eventType === 'transcript.data';

      if (text && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk:transcript', {
          text,
          speaker: speakerName,
          isFinal,
          timestamp: Date.now(),
        });
      }
    }
  });

  // ── macOS permissions (no-op on Windows) ───────────────────────────────────
  if (process.platform === 'darwin') {
    try {
      RecallAiSdk.requestPermission('accessibility');
      RecallAiSdk.requestPermission('microphone');
      RecallAiSdk.requestPermission('screen-capture');
    } catch (err) {
      console.warn('[SDK] Permission request failed:', err.message);
    }
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

/** Return the currently detected meeting (or null). */
ipcMain.handle('sdk:getDetectedMeeting', () => currentDetectedMeeting);

/** Start recording. windowId and uploadToken come from the renderer. */
ipcMain.handle('sdk:startRecording', async (_event, { windowId, uploadToken }) => {
  if (!RecallAiSdk) throw new Error('Desktop SDK not available');
  console.log('[SDK] startRecording windowId=%s token=%s...', windowId, uploadToken?.slice(0, 8));
  await RecallAiSdk.startRecording({ windowId, uploadToken });
  currentRecordingWindowId = windowId;
  sdkIsRecording = true;
  console.log('[SDK] Recording started');
});

/** Stop the current recording — requires the same windowId used to start. */
ipcMain.handle('sdk:stopRecording', async () => {
  if (!RecallAiSdk || !sdkIsRecording || !currentRecordingWindowId) {
    console.log('[SDK] stopRecording skipped — not recording');
    return;
  }
  try {
    await RecallAiSdk.stopRecording({ windowId: currentRecordingWindowId });
    sdkIsRecording = false;
    currentRecordingWindowId = null;
    console.log('[SDK] Recording stopped');
  } catch (err) {
    console.error('[SDK] stopRecording error:', err);
  }
});

// ─── Express + Electron setup ─────────────────────────────────────────────────

function startServer() {
  const expressApp = express();

  const distPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist')
    : path.join(__dirname, 'dist');

  expressApp.use(express.static(distPath));

  PROXY_PATHS.forEach(pathPrefix => {
    expressApp.use(
      pathPrefix,
      createProxyMiddleware({
        target: API_URL,
        changeOrigin: true,
        ws: pathPrefix === '/socket.io',
        logLevel: 'debug'
      })
    );
  });

  expressApp.get('*', (_req, res) => {
    const resolvedDist = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist')
      : path.join(__dirname, 'dist');
    res.sendFile(path.join(resolvedDist, 'index.html'));
  });

  server = expressApp.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    createWindow();
  });
}

function createWindow() {
  const iconPath = path.join(__dirname, 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Expose the contextBridge surface defined in preload.js
      preload: path.join(__dirname, 'preload.js'),
    },
    autoHideMenuBar: true,
  });

  mainWindow.loadURL(`http://localhost:${PORT}/login`);

  if (!app.isPackaged && process.env.SALESIDE_OPEN_DEVTOOLS === 'true') {
    mainWindow.webContents.openDevTools();
  }

  if (app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = (input.key || '').toUpperCase();
      if (key === 'F12' || (input.control && input.shift && key === 'I')) {
        event.preventDefault();
      }
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Init the Desktop Recording SDK before the window opens so meeting
  // detection is active as soon as the app launches.
  initDesktopSdk();
  startServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  if (server) {
    server.close();
  }
});
