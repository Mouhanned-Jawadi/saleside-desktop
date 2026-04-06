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
     * Register a callback that fires when the SDK detects a meeting window.
     * @param {function({id, title, platform}): void} callback
     */
    onMeetingDetected: (callback) => {
      ipcRenderer.on('sdk:meetingDetected', (_event, data) => callback(data));
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

    /** Remove all listeners for a given SDK channel (use on component unmount). */
    removeAllListeners: (channel) => {
      const allowed = ['sdk:meetingDetected', 'sdk:stateChange', 'sdk:recordingEnded', 'sdk:transcript'];
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
   * Used by aiBotService to build callback URLs.
   * @returns {string}
   */
  getFrontendOrigin: () => 'http://localhost:3000',
});
