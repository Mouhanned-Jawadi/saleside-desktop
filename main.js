const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
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

// ─── Stealth coaching overlay state ─────────────────────────────────────────
let overlayWindow = null;          // the frameless/transparent/content-protected HUD
let overlayClickThrough = false;   // current click-through state
let overlayPinned = true;          // alwaysOnTop pinned (default on)
let stealthEnabled = true;         // screen-share invisibility for BOTH app + overlay (default: invisible)
const OVERLAY_SIZES = {            // window sizes for the three layout states
  pill:     { width: 340, height: 64 },
  compact:  { width: 404, height: 300 },
  // expanded carries a side "mini conversation" column beside the coaching card,
  // so it is wider/taller than compact.
  expanded: { width: 600, height: 520 },
};
let overlaySize = 'compact';

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

// Best-effort extraction of a relative-seconds timestamp from a Recall transcript
// word object, mirroring the same defensive probing the backend does for the web
// bot-join path (SaleSide-Back-2.0/app/endpoints/recall_routes.py, _word_relative_time).
// Recall has nested this as {"start_timestamp": {"relative": 12.3, ...}} historically,
// but the shape isn't guaranteed to match here — this may simply find nothing, in
// which case the segment timing stays null and callers degrade gracefully.
function wordRelativeTime(word, key) {
  const val = word ? word[`${key}_timestamp`] : undefined;
  if (val && typeof val === 'object' && typeof val.relative === 'number') return val.relative;
  if (typeof val === 'number') return val;
  const flat = word ? word[key] : undefined;
  if (typeof flat === 'number') return flat;
  return undefined;
}

// Compute a segment's (start, end) relative-second timestamps from its words array.
// Returns nulls when no word carries a recognizable timestamp field.
function segmentRelativeTimes(words) {
  const starts = (words || []).map(w => wordRelativeTime(w, 'start')).filter(t => typeof t === 'number');
  const ends = (words || []).map(w => wordRelativeTime(w, 'end')).filter(t => typeof t === 'number');
  if (starts.length && ends.length) {
    return { start: Math.min(...starts), end: Math.max(...ends) };
  }
  return { start: null, end: null };
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

      // Segment timing for the scorecard's Interruptions/monologue-duration metrics —
      // only worth computing for final chunks, and only if the SDK actually exposes
      // per-word timestamps here (unconfirmed; degrades to null if it doesn't).
      const { start: segStart, end: segEnd } = isFinal ? segmentRelativeTimes(words) : { start: null, end: null };

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk:transcript', {
          text,
          speaker: speakerName,
          isFinal,
          timestamp: Date.now(),
          isLocalSpeaker: sdkMarkedLocal,
          isHost: !!(participant.is_host),
          segStart,
          segEnd,
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

// ─── Persistent auth token store ─────────────────────────────────────────────
// The renderer's localStorage is scoped by origin (http://localhost:<port>), and the
// Express port can drift between launches — which would silently lose the session.
// We persist the JWT in a small file under userData so it survives regardless of port,
// and rehydrate the renderer's localStorage from it at startup.

/** Absolute path to the token file (computed lazily; app must be ready). */
function authTokenFilePath() {
  return path.join(app.getPath('userData'), 'auth.json');
}

/** Read the stored JWT, or null if absent/unreadable. */
function readStoredToken() {
  try {
    const raw = fs.readFileSync(authTokenFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.token === 'string' && parsed.token ? parsed.token : null;
  } catch (_) {
    return null; // missing or corrupt file → treat as no session
  }
}

/** Persist the JWT to disk (best-effort). */
function writeStoredToken(token) {
  try {
    fs.writeFileSync(authTokenFilePath(), JSON.stringify({ token: token || '' }), 'utf8');
  } catch (err) {
    console.warn('[Auth] Failed to persist token:', err.message);
  }
}

/** Remove the persisted JWT (best-effort). */
function clearStoredToken() {
  try {
    fs.rmSync(authTokenFilePath(), { force: true });
  } catch (err) {
    console.warn('[Auth] Failed to clear token:', err.message);
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

/** Return the active server port so the preload can expose the correct origin. */
ipcMain.handle('app:getPort', () => activePort);

// Auth token bridge — lets the renderer persist the JWT independently of the
// volatile localhost origin so the desktop app reopens to the dashboard when signed in.
ipcMain.handle('auth:getToken', () => readStoredToken());
ipcMain.handle('auth:setToken', (_event, token) => { writeStoredToken(token); return true; });
ipcMain.handle('auth:clearToken', () => { clearStoredToken(); return true; });

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
    // Never leave a zombie always-on-top, invisible overlay with no parent window
    // (it has no taskbar entry and can't be focused — impossible for users to close).
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
    overlayWindow = null;
    unregisterOverlayHotkeys();
  });
}

// ─── Stealth coaching overlay ────────────────────────────────────────────────

/** Per-OS, honest screen-share-protection status for the overlay's stealth chip. */
function getStealthStatus() {
  // When the user has opted into visible mode, report it honestly — the overlay
  // (and the app) are intentionally capturable.
  if (!stealthEnabled) return { level: 'visible', label: 'Visible to everyone' };
  const platform = process.platform;
  if (platform === 'win32') {
    // WDA_EXCLUDEFROMCAPTURE requires Windows 10 build 19041 (version 2004) or newer.
    let build = 0;
    try { build = parseInt((require('os').release().split('.')[2]) || '0', 10); } catch (_) {}
    const supported = build >= 19041;
    return {
      platform: 'win32',
      level: supported ? 'hidden' : 'unsupported',
      label: supported ? 'Hidden from screen share' : 'Update Windows to hide from share',
      build,
    };
  }
  if (platform === 'darwin') {
    // NSWindowSharingNone is honored by browser getDisplayMedia capture, but NOT by
    // ScreenCaptureKit used by the native Zoom/Teams desktop clients (Sonoma+).
    return {
      platform: 'darwin',
      level: 'partial',
      label: 'Hidden from browser share',
      note: 'May be visible to native Zoom/Teams',
    };
  }
  return { platform, level: 'unknown', label: 'Screen-share status unknown' };
}

/** Apply (and RE-apply) capture exclusion + always-on-top. Must run after creation,
 *  after every show, and after every programmatic move/resize/monitor change —
 *  Windows drops WDA_EXCLUDEFROMCAPTURE on hide/show and some cross-monitor moves. */
function applyOverlayStealth(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setContentProtection(stealthEnabled); // Win: WDA_EXCLUDEFROMCAPTURE / mac: NSWindowSharingNone
    win.setAlwaysOnTop(overlayPinned, 'screen-saver');
    if (process.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
  } catch (e) {
    console.warn('[Overlay] applyOverlayStealth failed:', e?.message || e);
  }
}

function sendStealthStatus() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:stealthStatus', getStealthStatus());
  }
}

const overlayBoundsFile = () => path.join(app.getPath('userData'), 'overlay-bounds.json');

function persistOverlayBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    fs.writeFileSync(
      overlayBoundsFile(),
      JSON.stringify({ ...overlayWindow.getBounds(), opacity: overlayWindow.getOpacity(), size: overlaySize })
    );
  } catch (_) {}
}

function restoreOverlayBounds(win) {
  try {
    const saved = JSON.parse(fs.readFileSync(overlayBoundsFile(), 'utf8'));
    if (typeof saved.opacity === 'number') win.setOpacity(saved.opacity);
    if (typeof saved.x === 'number' && typeof saved.y === 'number') {
      const display = screen.getDisplayMatching(saved) || screen.getPrimaryDisplay();
      const wa = display.workArea;
      const w = saved.width || win.getBounds().width;
      const h = saved.height || win.getBounds().height;
      const x = Math.min(Math.max(saved.x, wa.x), wa.x + wa.width - w);
      const y = Math.min(Math.max(saved.y, wa.y), wa.y + wa.height - h);
      win.setBounds({ x, y, width: w, height: h });
    }
  } catch (_) { /* first run: keep the default top-center position */ }
}

/** Re-clamp the overlay into a connected display (e.g. after a monitor is unplugged)
 *  and re-apply stealth (affinity can drop during the move). */
function clampOverlayToDisplays() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const b = overlayWindow.getBounds();
  const display = screen.getDisplayMatching(b) || screen.getPrimaryDisplay();
  const wa = display.workArea;
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - b.width);
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - b.height);
  if (x !== b.x || y !== b.y) overlayWindow.setBounds({ x, y, width: b.width, height: b.height });
  applyOverlayStealth(overlayWindow);
}

function createOverlayWindow(port) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (!overlayWindow.isVisible()) { overlayWindow.showInactive(); applyOverlayStealth(overlayWindow); }
    return overlayWindow;
  }
  const { width, height } = OVERLAY_SIZES[overlaySize] || OVERLAY_SIZES.compact;
  const wa = screen.getPrimaryDisplay().workArea;

  overlayWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(wa.x + (wa.width - width) / 2), // default: top-center (eyes near webcam)
    y: Math.round(wa.y + 120),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,    // read-only HUD — never steals focus from the meeting
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // keep rendering while the meeting window is focused
    },
  });

  if (process.platform === 'darwin') {
    try { overlayWindow.setWindowButtonVisibility(false); } catch (_) {}
  }

  restoreOverlayBounds(overlayWindow);
  overlayWindow.loadURL(`http://localhost:${port}/overlay`);

  overlayWindow.once('ready-to-show', () => {
    applyOverlayStealth(overlayWindow);
    overlayWindow.showInactive();         // show without stealing focus from the meeting
    applyOverlayStealth(overlayWindow);   // re-apply post-show (Win11 timing + hide/show bug)
    sendStealthStatus();
  });
  overlayWindow.on('show', () => applyOverlayStealth(overlayWindow));
  overlayWindow.on('moved', persistOverlayBounds);
  overlayWindow.on('resize', persistOverlayBounds);
  overlayWindow.on('closed', () => { overlayWindow = null; });
  return overlayWindow;
}

function applyOverlaySize() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const { width, height } = OVERLAY_SIZES[overlaySize] || OVERLAY_SIZES.compact;
  const [x, y] = overlayWindow.getPosition();
  overlayWindow.setBounds({ x, y, width, height });
  applyOverlayStealth(overlayWindow);
  overlayWindow.webContents.send('overlay:request-size', { size: overlaySize });
  persistOverlayBounds();
}

function nudgeOverlay(dx, dy) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const [x, y] = overlayWindow.getPosition();
  overlayWindow.setPosition(x + dx, y + dy);
  applyOverlayStealth(overlayWindow); // re-apply after programmatic move
  persistOverlayBounds();
}

function toggleOverlayVisibility() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (overlayWindow.isVisible()) overlayWindow.hide();
  else { overlayWindow.showInactive(); applyOverlayStealth(overlayWindow); }
}

function cycleOverlaySize() {
  const order = ['pill', 'compact', 'expanded'];
  overlaySize = order[(order.indexOf(overlaySize) + 1) % order.length];
  applyOverlaySize();
}

function registerOverlayHotkeys() {
  const mod = process.platform === 'darwin' ? 'Command' : 'Control';
  const reg = (accel, fn) => {
    try {
      const ok = globalShortcut.register(accel, fn);
      if (!ok) console.warn('[Overlay] hotkey already owned by another app, not registered:', accel);
    } catch (e) { console.warn('[Overlay] hotkey register error', accel, e?.message || e); }
  };
  // Keep the global set small + low-conflict. Movement uses Alt to avoid clobbering
  // browser/meeting Cmd+Arrow word-nav.
  reg(`${mod}+\\`, toggleOverlayVisibility);     // panic hide / show — always works, unfocused
  reg(`${mod}+Shift+Space`, cycleOverlaySize);   // cycle pill → compact → expanded
  reg(`${mod}+Alt+Up`,    () => nudgeOverlay(0, -40));
  reg(`${mod}+Alt+Down`,  () => nudgeOverlay(0,  40));
  reg(`${mod}+Alt+Left`,  () => nudgeOverlay(-40, 0));
  reg(`${mod}+Alt+Right`, () => nudgeOverlay( 40, 0));
}

function unregisterOverlayHotkeys() {
  try { globalShortcut.unregisterAll(); } catch (_) {}
}

// ─── Overlay IPC ─────────────────────────────────────────────────────────────
ipcMain.handle('overlay:show', () => {
  createOverlayWindow(activePort);
  registerOverlayHotkeys();
  // Hide the main window's coaching feed from screen share too, so an "entire screen"
  // share never reveals it — only the stealth overlay shows on the rep's own screen.
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setContentProtection(stealthEnabled); } catch (_) {}
  }
  return true;
});

ipcMain.handle('overlay:hide', () => {
  unregisterOverlayHotkeys();
  if (overlayWindow && !overlayWindow.isDestroyed()) { persistOverlayBounds(); overlayWindow.destroy(); }
  overlayWindow = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setContentProtection(false); } catch (_) {}
  }
  return true;
});

ipcMain.on('overlay:pushState', (_e, snapshot) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:state', snapshot);
  }
});

ipcMain.on('overlay:move-by', (_e, { dx, dy } = {}) => nudgeOverlay(dx || 0, dy || 0));

ipcMain.on('overlay:resize-by', (_e, { dw, dh } = {}) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const b = overlayWindow.getBounds();
  overlayWindow.setBounds({
    x: b.x, y: b.y,
    width: Math.max(300, Math.min(560, b.width + (dw || 0))),
    height: Math.max(140, b.height + (dh || 0)),
  });
  applyOverlayStealth(overlayWindow);
  persistOverlayBounds();
});

ipcMain.on('overlay:set-opacity', (_e, value) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.setOpacity(Math.min(1, Math.max(0.2, Number(value) || 1)));
  persistOverlayBounds();
});

ipcMain.on('overlay:set-clickthrough', (_e, enabled) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayClickThrough = !!enabled;
  overlayWindow.setIgnoreMouseEvents(overlayClickThrough, { forward: true });
});

ipcMain.on('overlay:set-pinned', (_e, pinned) => {
  overlayPinned = !!pinned;
  applyOverlayStealth(overlayWindow);
});

ipcMain.on('overlay:set-size', (_e, size) => {
  if (['pill', 'compact', 'expanded'].includes(size)) { overlaySize = size; applyOverlaySize(); }
});

ipcMain.on('overlay:hide-self', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
});

// Visible/Invisible switch (driven from the Live Call page). Flips screen-share
// content-protection for BOTH the main app window and the overlay, live.
ipcMain.on('overlay:set-stealth', (_e, enabled) => {
  stealthEnabled = !!enabled;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setContentProtection(stealthEnabled); } catch (_) {}
  }
  applyOverlayStealth(overlayWindow); // no-ops safely if the overlay isn't up
  sendStealthStatus();                // refresh the honest chip in the overlay
});

app.whenReady().then(() => {
  // Init the Desktop Recording SDK before the window opens so meeting
  // detection is active as soon as the app launches.
  initDesktopSdk();
  startServer();

  // Keep the overlay on a connected display + re-stealthed when monitors change.
  try {
    screen.on('display-removed', clampOverlayToDisplays);
    screen.on('display-metrics-changed', clampOverlayToDisplays);
  } catch (_) {}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// globalShortcut registrations must be released before quit.
app.on('will-quit', () => { unregisterOverlayHotkeys(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  if (server) {
    server.close();
  }
});
