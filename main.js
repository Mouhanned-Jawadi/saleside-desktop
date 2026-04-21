const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const net = require('net');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

// Installer passes --quit to gracefully close the running app before overwriting files.
if (process.argv.includes('--quit')) {
  app.quit();
  process.exit(0);
}

// ─── Recall Desktop Recording SDK ────────────────────────────────────────────
let RecallAiSdk = null;
try {
  RecallAiSdk = require('@recallai/desktop-sdk');
} catch (err) {
  console.warn('[SDK] @recallai/desktop-sdk not installed — desktop recording disabled:', err.message);
}

// Config
const PREFERRED_PORT = 3000;
const API_URL = 'https://saleside-back-20-production.up.railway.app/';
const PROXY_PATHS = ['/api', '/auth', '/launch-bot', '/socket.io'];

let mainWindow;
let server;
let activePort = PREFERRED_PORT; // set once a free port is found

/** Resolve with the first free TCP port starting from `start`. */
function findFreePort(start) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(findFreePort(start + 1)));
    probe.once('listening', () => {
      probe.close(() => resolve(start));
    });
    probe.listen(start, '127.0.0.1');
  });
}

// ─── SDK State ────────────────────────────────────────────────────────────────
/**
 * All currently detected meeting windows, keyed by window ID.
 * Multiple meetings can be open at the same time (e.g. Zoom + Teams).
 */
let detectedMeetings = new Map(); // windowId → { id, title, platform }
/** Most recently detected meeting — kept for backward-compat with single-meeting IPC. */
let currentDetectedMeeting = null;
/** WindowId of the currently active recording, or null when idle. */
let currentRecordingWindowId = null;
/** Whether the SDK is actively recording right now. */
let sdkIsRecording = false;

/** Broadcast the full list of detected meetings to the renderer. */
function broadcastDetectedMeetings() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sdk:detectedMeetingsUpdated', Array.from(detectedMeetings.values()));
  }
}

function initDesktopSdk() {
  if (!RecallAiSdk) return;

  try {
    RecallAiSdk.init({ apiUrl: 'https://us-west-2.recall.ai' });
    console.log('[SDK] Initialized with us-west-2 region');
  } catch (err) {
    console.error('[SDK] Failed to initialize:', err);
    return;
  }

  // ── Meeting detection (fires for Zoom, Teams, and Google Meet windows) ──────
  RecallAiSdk.addEventListener('meeting-detected', (evt) => {
    const { window: meetingWindow } = evt;
    console.log('[SDK] Meeting detected:', meetingWindow);

    const meeting = {
      id: meetingWindow.id,
      title: meetingWindow.title || '',
      platform: meetingWindow.platform || 'unknown',
    };

    detectedMeetings.set(meetingWindow.id, meeting);
    currentDetectedMeeting = meeting;

    // Notify the renderer of the specific detection and the updated full list
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sdk:meetingDetected', meeting);
    }
    broadcastDetectedMeetings();
  });

  // ── Meeting ended (window closed — SDK emits this when a meeting app closes) ─
  try {
    RecallAiSdk.addEventListener('meeting-ended', (evt) => {
      const windowId = evt?.window?.id;
      console.log('[SDK] Meeting ended for window:', windowId);
      if (windowId !== undefined) {
        detectedMeetings.delete(windowId);
        // Update currentDetectedMeeting to another open meeting, or null
        if (currentDetectedMeeting?.id === windowId) {
          const remaining = Array.from(detectedMeetings.values());
          currentDetectedMeeting = remaining.length > 0 ? remaining[remaining.length - 1] : null;
        }
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk:meetingEnded', { windowId });
      }
      broadcastDetectedMeetings();
    });
  } catch (_) {
    // SDK version may not support meeting-ended — safe to ignore
  }

  // ── SDK state transitions ───────────────────────────────────────────────────
  RecallAiSdk.addEventListener('sdk-state-change', (evt) => {
    const stateCode = evt?.sdk?.state?.code || 'unknown';
    console.log('[SDK] State change:', stateCode);

    if (stateCode === 'recording') {
      sdkIsRecording = true;
    } else if (stateCode === 'idle') {
      sdkIsRecording = false;
      currentRecordingWindowId = null;
      // Do NOT clear detectedMeetings here — the meeting window may still be
      // open even though recording has stopped. Meetings are cleared only when
      // the window actually closes (meeting-ended) or the app quits.
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
    // Keep detectedMeetings intact — the meeting window is likely still open.

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

    // Log every event type so we can diagnose what the SDK is actually sending
    console.log('[SDK] realtime-event type=%s', eventType);

    if (eventType === 'transcript.data' || eventType === 'transcript.partial_data') {
      const words = evt?.data?.words || [];
      const text = words.map(w => w.text || '').join(' ').trim();
      const participant = evt?.data?.participant || {};
      const speakerName = participant.name || String(participant.id || 'Unknown');
      const isFinal = eventType === 'transcript.data';

      // Detect if the SDK itself identifies this participant as the local user.
      // Recall.ai may expose is_self, is_local, or type='local' depending on SDK version.
      const sdkMarkedLocal = !!(participant.is_self || participant.is_local || participant.type === 'local');

      console.log('[SDK] transcript speaker=%s isFinal=%s isLocal=%s text=%s', speakerName, isFinal, sdkMarkedLocal, text.slice(0, 60));

      if (text && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk:transcript', {
          text,
          speaker: speakerName,
          isFinal,
          timestamp: Date.now(),
          isLocalSpeaker: sdkMarkedLocal,
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

/** Return the active server port so the preload can expose the correct origin. */
ipcMain.handle('app:getPort', () => activePort);

/** Return the currently detected meeting (or null) — backward-compat single-item form. */
ipcMain.handle('sdk:getDetectedMeeting', () => {
  if (currentDetectedMeeting) return currentDetectedMeeting;
  const all = Array.from(detectedMeetings.values());
  return all.length > 0 ? all[all.length - 1] : null;
});

/** Return ALL currently detected meeting windows as an array. */
ipcMain.handle('sdk:getDetectedMeetings', () => Array.from(detectedMeetings.values()));

/** Start recording. windowId and uploadToken come from the renderer. */
ipcMain.handle('sdk:startRecording', async (_event, { windowId, uploadToken }) => {
  if (!RecallAiSdk) throw new Error('Desktop SDK not available');
  console.log('[SDK] startRecording windowId=%s token=%s...', windowId, uploadToken?.slice(0, 8));
  try {
    await RecallAiSdk.startRecording({ windowId, uploadToken });
    currentRecordingWindowId = windowId;
    sdkIsRecording = true;
    console.log('[SDK] Recording started successfully for windowId=%s', windowId);
  } catch (err) {
    console.error('[SDK] startRecording FAILED:', err);
    throw err;
  }
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

async function startServer() {
  activePort = await findFreePort(PREFERRED_PORT);
  if (activePort !== PREFERRED_PORT) {
    console.log(`[Server] Port ${PREFERRED_PORT} in use — using port ${activePort} instead`);
  }

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

  server = expressApp.listen(activePort, () => {
    console.log(`Server running on http://localhost:${activePort}`);
    createWindow(activePort);
  });
}

function createWindow(port) {
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

  mainWindow.loadURL(`http://localhost:${port}/login`);

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
