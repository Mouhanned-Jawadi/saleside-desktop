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
      ];
      if (allowed.includes(channel)) {
        ipcRenderer.removeAllListeners(channel);
      }
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
