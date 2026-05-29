/**
 * Electron preload script.
 *
 * Runs in the renderer process context with access to Node/Electron APIs via
 * contextBridge.  Exposes a safe, typed surface as `window.electron` to the
 * React app (which has nodeIntegration: false).
 *
 * Exposed APIs
 * ─────────────
 * window.electron.sdk.*          – Recall Desktop Recording SDK IPC bridge
 * window.electron.onAIBotCallback(cb)   – legacy callback listener (unused today)
 * window.electron.getFrontendOrigin()   – returns the Express server origin
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // ─── Recall Desktop Recording SDK ─────────────────────────────────────────
  sdk: {
    /**
     * Returns the currently detected meeting window info, or null if no
     * meeting is active.
     * @returns {Promise<{id: number, title: string, platform: string} | null>}
     */
    getDetectedMeeting: () => ipcRenderer.invoke('sdk:getDetectedMeeting'),

    /**
     * Start recording the given meeting window.
     * @param {number} windowId   – window id from meeting-detected event
     * @param {string} uploadToken – token from /api/recall/sdk-upload backend call
     * @returns {Promise<void>}
     */
    startRecording: (windowId, uploadToken) =>
      ipcRenderer.invoke('sdk:startRecording', { windowId, uploadToken }),

    /**
     * Stop the current SDK recording.
     * @returns {Promise<void>}
     */
    stopRecording: () => ipcRenderer.invoke('sdk:stopRecording'),

    /**
     * Returns ALL currently detected meeting windows as an array.
     * Includes Zoom, Teams, and Google Meet — both desktop apps and browser tabs.
     * @returns {Promise<Array<{id: number, title: string, platform: string}>>}
     */
    getDetectedMeetings: () => ipcRenderer.invoke('sdk:getDetectedMeetings'),

    /**
     * Register a callback that fires when the SDK detects a meeting window.
     * @param {function({id, title, platform}): void} callback
     */
    onMeetingDetected: (callback) => {
      ipcRenderer.on('sdk:meetingDetected', (_event, data) => callback(data));
    },

    /**
     * Register a callback that fires when a meeting window is closed/ended.
     * @param {function({windowId: number}): void} callback
     */
    onMeetingEnded: (callback) => {
      ipcRenderer.on('sdk:meetingEnded', (_event, data) => callback(data));
    },

    /**
     * Register a callback that fires whenever the full list of detected
     * meetings changes (meeting opened or closed).
     * @param {function(Array<{id, title, platform}>): void} callback
     */
    onDetectedMeetingsUpdated: (callback) => {
      ipcRenderer.on('sdk:detectedMeetingsUpdated', (_event, data) => callback(data));
    },

    /**
     * Register a callback that fires on SDK state transitions.
     * State codes: 'idle' | 'recording' | 'uploading'
     * @param {function({code: string}): void} callback
     */
    onSdkStateChange: (callback) => {
      ipcRenderer.on('sdk:stateChange', (_event, data) => callback(data));
    },

    /**
     * Register a callback that fires when the SDK recording has ended and
     * the upload is complete.
     * @param {function({windowId: number}): void} callback
     */
    onRecordingEnded: (callback) => {
      ipcRenderer.on('sdk:recordingEnded', (_event, data) => callback(data));
    },

    /**
     * Register a callback for real-time transcript events delivered via
     * desktop_sdk_callback (faster than the webhook path).
     * @param {function({text, speaker, isFinal, timestamp}): void} callback
     */
    onTranscript: (callback) => {
      ipcRenderer.on('sdk:transcript', (_event, data) => callback(data));
    },

    /**
     * Register a callback for raw SDK diagnostic log lines forwarded from
     * main.js.  Use this to surface realtime-event structure and errors in
     * the UI without needing DevTools.
     * @param {function(string): void} callback
     */
    onSdkLog: (callback) => {
      ipcRenderer.on('sdk:sdkLog', (_event, msg) => callback(msg));
    },

    /**
     * Register a callback for macOS permission problems (screen recording /
     * microphone / accessibility) detected when starting or during recording.
     * @param {function({reason: string, message: string}): void} callback
     */
    onPermissionIssue: (callback) => {
      ipcRenderer.on('sdk:permissionIssue', (_event, data) => callback(data));
    },

    /** Remove all listeners for a given SDK channel (use on component unmount). */
    removeAllListeners: (channel) => {
      const allowed = [
        'sdk:meetingDetected',
        'sdk:meetingEnded',
        'sdk:detectedMeetingsUpdated',
        'sdk:stateChange',
        'sdk:recordingEnded',
        'sdk:transcript',
        'sdk:sdkLog',
        'sdk:permissionIssue',
      ];
      if (allowed.includes(channel)) {
        ipcRenderer.removeAllListeners(channel);
      }
    },
  },

  // ─── Stealth Coaching Overlay ───────────────────────────────────────────────
  // A separate frameless/transparent/content-protected window that floats over the
  // meeting and is invisible to screen share. The MAIN window relays coaching state
  // to it via overlay.pushState(); the OVERLAY window consumes it via overlay.onState().
  overlay: {
    /** (main window) Create + show the overlay, register hotkeys, protect the main window. */
    show: () => ipcRenderer.invoke('overlay:show'),
    /** (main window) Hide/destroy the overlay, unregister hotkeys, unprotect the main window. */
    hide: () => ipcRenderer.invoke('overlay:hide'),
    /** (main window) Relay a compact coaching snapshot to the overlay. Fire-and-forget. */
    pushState: (snapshot) => ipcRenderer.send('overlay:pushState', snapshot),
    /** (overlay window) Subscribe to relayed coaching snapshots. */
    onState: (callback) => ipcRenderer.on('overlay:state', (_e, data) => callback(data)),
    removeStateListener: () => ipcRenderer.removeAllListeners('overlay:state'),
    /** (overlay window) Report the runtime stealth/protection status to render the honest chip. */
    onStealthStatus: (callback) => ipcRenderer.on('overlay:stealthStatus', (_e, data) => callback(data)),
    /** (overlay window) Window controls driven from in-overlay UI buttons. */
    moveBy: (dx, dy) => ipcRenderer.send('overlay:move-by', { dx, dy }),
    resizeBy: (dw, dh) => ipcRenderer.send('overlay:resize-by', { dw, dh }),
    setOpacity: (value) => ipcRenderer.send('overlay:set-opacity', value),
    setClickThrough: (enabled) => ipcRenderer.send('overlay:set-clickthrough', enabled),
    setPinned: (pinned) => ipcRenderer.send('overlay:set-pinned', pinned),
    setSize: (size) => ipcRenderer.send('overlay:set-size', size), // 'pill' | 'compact' | 'expanded'
    hideSelf: () => ipcRenderer.send('overlay:hide-self'),
    /** (overlay window) Receive size-cycle requests originating from the global hotkey. */
    onSizeRequest: (callback) => ipcRenderer.on('overlay:request-size', (_e, data) => callback(data)),
    removeAllOverlayListeners: () => {
      ['overlay:state', 'overlay:stealthStatus', 'overlay:request-size'].forEach((c) =>
        ipcRenderer.removeAllListeners(c)
      );
    },
  },

  // ─── Legacy / compatibility ────────────────────────────────────────────────

  /**
   * Register a listener for AI bot callbacks forwarded from the main process.
   * @param {function(data): void} callback
   */
  onAIBotCallback: (callback) => {
    ipcRenderer.on('ai-bot-callback', (_event, data) => callback(data));
  },

  /**
   * Returns the origin of the Electron-embedded Express server.
   * Uses the actual port chosen at startup (may differ from 3000 if that port was busy).
   * @returns {Promise<string>}
   */
  getFrontendOrigin: () =>
    ipcRenderer.invoke('app:getPort').then((port) => `http://localhost:${port}`),
});
