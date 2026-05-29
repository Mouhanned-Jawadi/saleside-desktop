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

// ── Robust payload extraction for Recall SDK realtime-event ──────────────────
// The SDK has changed the nesting of transcript data between versions. Rather
// than hard-coding a path, walk the event object (breadth-first, bounded depth)
// and return the first value matching a predicate.
function findFirst(obj, predicate, depth = 0) {
  if (obj == null || depth > 6) return undefined;
  if (predicate(obj)) return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = findFirst(item, predicate, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      const hit = findFirst(obj[key], predicate, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

// A words array: non-empty array whose first element is a word object with a
// text-bearing field. Guards against matching unrelated arrays.
const isWordsArray = (v) =>
  Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null &&
  ('text' in v[0] || 'word' in v[0] || 'value' in v[0]);

// A participant object: must carry a speaker identity (name) or a speaker-role
// flag. We intentionally do NOT match on bare `id` alone, so a `bot: { id }`
// wrapper isn't mistaken for the participant.
const isParticipantObject = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) &&
  ('name' in v || 'is_self' in v || 'is_local' in v || 'is_host' in v);

// A direct transcript string under a key literally named `transcript`/`text`
// (some SDK shapes expose a flat string instead of a words array). Scoped to
// those keys so we never grab unrelated strings like the event-type label.
function findTranscriptString(obj, depth = 0) {
  if (obj == null || depth > 6 || typeof obj !== 'object') return undefined;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = findTranscriptString(item, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if ((key === 'transcript' || key === 'text') && typeof val === 'string' && val.trim()) {
      return val;
    }
    const hit = findTranscriptString(val, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
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

  // ── Meeting closed/ended (window closed) ──────────────────────────────────
  // Different SDK versions use different event names — listen to both.
  const _handleMeetingClosed = (evt) => {
    const windowId = evt?.window?.id;
    console.log('[SDK] Meeting closed for window:', windowId);
    // If the window we are actively recording just closed, audio capture dies
    // silently and the renderer would only show "No audio detected" 20s later.
    // Surface it loudly so window-identity churn (common on Google Meet when the
    // tab title/url changes mid-call) is diagnosable instead of invisible.
    if (sdkIsRecording && windowId !== undefined && windowId === currentRecordingWindowId) {
      const warn = `[SDK] WARNING: the window being recorded (${windowId}) closed while recording — audio capture has stopped. If this is Google Meet, the meeting window changed identity; restart the session on the newly detected meeting.`;
      console.warn(warn);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk:sdkLog', warn);
      }
    }
    if (windowId !== undefined) {
      detectedMeetings.delete(windowId);
      if (currentDetectedMeeting?.id === windowId) {
        const remaining = Array.from(detectedMeetings.values());
        currentDetectedMeeting = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sdk:meetingEnded', { windowId });
    }
    broadcastDetectedMeetings();
  };
  try { RecallAiSdk.addEventListener('meeting-closed', _handleMeetingClosed); } catch (_) {}
  try { RecallAiSdk.addEventListener('meeting-ended', _handleMeetingClosed); } catch (_) {}

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

  // ── Recording started ───────────────────────────────────────────────────────
  try {
    RecallAiSdk.addEventListener('recording-started', (evt) => {
      const windowId = evt?.window?.id ?? null;
      const msg = `[SDK] Recording started for windowId=${windowId}`;
      console.log(msg);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk:sdkLog', msg);
      }
    });
  } catch (_) {}

  // ── Media capture status ────────────────────────────────────────────────────
  // Fires when audio capture starts or stops. capturing=false means the SDK
  // cannot access the meeting audio — surfaces this immediately in the UI.
  try {
    RecallAiSdk.addEventListener('media-capture-status', (evt) => {
      const capturing = evt?.capturing ?? evt?.status?.capturing ?? null;
      const msg = `[SDK] media-capture-status: capturing=${capturing} raw=${JSON.stringify(evt).slice(0, 150)}`;
      console.log(msg);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk:sdkLog', msg);
        // On macOS, capturing=false while we believe we're recording means a TCC
        // permission (screen recording / microphone) is blocking capture. Surface
        // it as an actionable message instead of silently producing no audio.
        if (process.platform === 'darwin' && capturing === false && sdkIsRecording) {
          mainWindow.webContents.send('sdk:permissionIssue', {
            reason: 'capture_stopped',
            message: 'macOS is not capturing meeting audio. Grant Screen Recording and Microphone to SaleSide in System Settings → Privacy & Security, then restart the app.',
          });
        }
      }
    });
  } catch (_) {}

  // ── SDK internal log events ─────────────────────────────────────────────────
  try {
    RecallAiSdk.addEventListener('log', (evt) => {
      const msg = `[SDK Internal Log] ${JSON.stringify(evt).slice(0, 200)}`;
      console.log(msg);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk:sdkLog', msg);
      }
    });
  } catch (_) {}

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
    // Recall.ai SDK uses 'event' field; guard against SDK version differences
    // by also checking 'type'. Log the FULL raw event so mismatches surface in
    // the renderer's SDK diagnostics panel (sdk:sdkLog IPC channel).
    const eventType = evt?.event || evt?.type || evt?.event_type || null;

    // Always log the raw event for diagnostics — forward to renderer too so
    // the user can see it without needing DevTools.
    const rawLog = `[SDK] realtime-event raw: ${JSON.stringify(evt).slice(0, 300)}`;
    console.log(rawLog);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sdk:sdkLog', rawLog);
    }

    if (!eventType) {
      console.warn('[SDK] realtime-event has no event/type field — unknown structure, skipping');
      return;
    }

    if (eventType === 'transcript.data' || eventType === 'transcript.partial_data') {
      // The Recall.ai SDK has historically wrapped transcript data at different
      // nesting depths across versions, e.g.:
      //   evt.data       = { bot: {...}, data: { participant, words } }
      //   evt.data.data  = { participant: {...}, words: [{text,...}] }
      // A fixed `evt.data.data || evt.data || evt` chain breaks the moment a
      // version adds/removes a wrapper. Instead, locate the words array and the
      // participant object wherever they live in the event object.
      const words = findFirst(evt, isWordsArray) || [];
      const participant = findFirst(evt, isParticipantObject) || {};
      const speakerName = participant.name || String(participant.id || 'Unknown');
      const isFinal = eventType === 'transcript.data';

      // Build text from the words array (newer SDKs sometimes rename text→word→value).
      // Fall back to a direct transcript string field if no words array is present.
      let text = words.map(w => w.text || w.word || w.value || '').join(' ').trim();
      if (!text) {
        const direct = findTranscriptString(evt);
        if (direct) text = String(direct).trim();
      }

      // is_host marks the meeting host — NOT the local recorder.
      // We rely on name matching in the backend (sales_rep_names config)
      // plus mic VAD (isLocalSpeaker) as a secondary signal.
      const sdkMarkedLocal = !!(participant.is_self || participant.is_local || participant.type === 'local');

      console.log('[SDK] transcript speaker=%s isFinal=%s isLocal=%s text=%s', speakerName, isFinal, sdkMarkedLocal, text.slice(0, 60));

      // A transcript event with no extractable text almost always means the SDK
      // payload shape changed (e.g. an unpinned version upgrade). Surface it loudly
      // instead of silently dropping the chunk — otherwise the renderer just shows
      // "No audio detected" with no clue why.
      if (!text) {
        const warn = `[SDK] WARNING: transcript event with empty text — SDK payload shape may have changed. raw=${JSON.stringify(evt).slice(0, 400)}`;
        console.warn(warn);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sdk:sdkLog', warn);
        }
        return;
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk:transcript', {
          text,
          speaker: speakerName,
          isFinal,
          timestamp: Date.now(),
          isLocalSpeaker: sdkMarkedLocal,
          isHost: !!(participant.is_host),
        });
      }
    }
  });

  // ── SDK error events ────────────────────────────────────────────────────────
  try {
    RecallAiSdk.addEventListener('error', (err) => {
      const msg = `[SDK] Error event: ${JSON.stringify(err)}`;
      console.error(msg);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk:sdkLog', msg);
      }
    });
  } catch (_) {}

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

  // On macOS, mic + screen-capture + accessibility are gated by TCC permissions.
  // Re-request right before recording (the startup request may have been dismissed,
  // and screen-capture in particular must be granted in System Settings). Without
  // these, the native SDK silently captures nothing and the session dies.
  if (process.platform === 'darwin') {
    for (const perm of ['accessibility', 'microphone', 'screen-capture']) {
      try { await RecallAiSdk.requestPermission(perm); }
      catch (err) { console.warn('[SDK] requestPermission(%s) failed: %s', perm, err?.message || err); }
    }
  }

  try {
    await RecallAiSdk.startRecording({ windowId, uploadToken });
    currentRecordingWindowId = windowId;
    sdkIsRecording = true;
    console.log('[SDK] Recording started successfully for windowId=%s', windowId);
  } catch (err) {
    console.error('[SDK] startRecording FAILED:', err);
    // On macOS a failure here is almost always a denied/ungranted permission.
    if (process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sdk:permissionIssue', {
        reason: 'start_failed',
        message: 'macOS blocked recording. Grant Screen Recording, Microphone, and Accessibility to SaleSide in System Settings → Privacy & Security, then restart the app.',
      });
    }
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

  // Ctrl+Shift+D opens DevTools in all builds for SDK diagnostics.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && (input.key || '').toUpperCase() === 'D') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

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
