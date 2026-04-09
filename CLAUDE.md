# SaleSide Desktop App — Claude Code Context

## Stack
Electron 28 / Express.js (internal proxy) / http-proxy-middleware / @recallai/desktop-sdk / electron-builder

## Entry Points
- `main.js` — Electron main process: SDK init, IPC handlers, Express proxy server, BrowserWindow
- `preload.js` — contextBridge surface exposed as `window.electron` to the renderer

## How It Works
1. Starts an Express server on `localhost:3000`
2. Serves the built React frontend (`SaleSide-Front-2.0/dist/` copied here as `dist/`)
3. Proxies `/api/*`, `/auth/*`, `/launch-bot/*`, `/socket.io/*` to the production backend
4. Opens Electron BrowserWindow pointing to `localhost:3000`
5. Initialises the Recall Desktop Recording SDK at startup (region: `us-west-2`)

## Recall Desktop Recording SDK

### Why
Desktop app records meetings locally — no bot joins the call. The SDK captures audio from Zoom, Google Meet, or Teams windows running on the machine.

### SDK Lifecycle
1. `main.js` calls `RecallAiSdk.init({ apiUrl: 'https://us-west-2.recall.ai' })` at startup
2. SDK fires `meeting-detected` → `main.js` stores `currentDetectedMeeting` and sends `sdk:meetingDetected` to renderer via `webContents.send`
3. Renderer (LiveCall page) calls `POST /api/recall/sdk-upload` → backend creates Recall SDK upload, returns `{ bot_id, upload_token }`
4. Renderer calls `window.electron.sdk.startRecording(windowId, uploadToken)` via IPC → `main.js` calls `RecallAiSdk.startRecording({ windowId, uploadToken })`
5. SDK sends real-time transcripts via `desktop_sdk_callback` → `realtime-event` fires in `main.js` → forwarded to renderer as `sdk:transcript`
6. Renderer POSTs each transcript to `/api/recall/transcript-webhook?source=desktop_sdk&sdk_bot_id=<bot_id>` → same backend LLM pipeline as bot flow
7. When session ends: renderer calls `window.electron.sdk.stopRecording()` + `POST /api/recall/sdk-session-end/<bot_id>`

### IPC Channels (main ↔ renderer)
| Channel | Direction | Purpose |
|---|---|---|
| `sdk:meetingDetected` | main → renderer | Meeting window detected |
| `sdk:stateChange` | main → renderer | SDK state: `idle` / `recording` |
| `sdk:recordingEnded` | main → renderer | Recording finished, upload started |
| `sdk:transcript` | main → renderer | Real-time transcript chunk |
| `sdk:getDetectedMeeting` | renderer → main (invoke) | Get current detected meeting |
| `sdk:startRecording` | renderer → main (invoke) | Start recording with windowId + uploadToken |
| `sdk:stopRecording` | renderer → main (invoke) | Stop active recording |

### Key State in main.js
- `currentDetectedMeeting` — `{ id, title, platform }` or `null`
- `currentRecordingWindowId` — windowId of active recording or `null`
- `sdkIsRecording` — boolean guard to prevent double-stop crash

## window.electron Surface (preload.js)
```js
window.electron.sdk.getDetectedMeeting()       // → Promise<meeting|null>
window.electron.sdk.startRecording(id, token)  // → Promise<void>
window.electron.sdk.stopRecording()            // → Promise<void>
window.electron.sdk.onMeetingDetected(cb)      // event subscription
window.electron.sdk.onSdkStateChange(cb)       // event subscription
window.electron.sdk.onRecordingEnded(cb)       // event subscription
window.electron.sdk.onTranscript(cb)           // real-time transcript chunks
window.electron.sdk.removeAllListeners(ch)     // cleanup on unmount
window.electron.onAIBotCallback(cb)            // legacy compatibility
window.electron.getFrontendOrigin()            // returns 'http://localhost:3000'
```

## Build Workflow
```bash
# 1. Build the React frontend
cd ../SaleSide-Front-2.0
npm run build

# 2. Copy dist to desktop app
cp -r dist/. ../SaleSide-Desktop-2.0/dist/

# 3a. Dev mode (uses dist/ as-is)
cd ../SaleSide-Desktop-2.0
npm start

# 3b. Production installer
npm run dist
# → release/SaleSide Setup 1.0.0.exe
```

## Commands
```bash
npm install      # installs @recallai/desktop-sdk, express, http-proxy-middleware
npm start        # dev mode — serves dist/ on localhost:3000
npm run dist     # builds Windows NSIS .exe installer
```

## Key Files
| File | Purpose |
|---|---|
| `main.js` | Electron main process, SDK init, IPC handlers, Express proxy |
| `preload.js` | contextBridge — `window.electron` surface for renderer |
| `dist/` | Built React frontend (copy from SaleSide-Front-2.0/dist/) |
| `release/` | Built installers |
| `package.json` | `asarUnpack` includes `@recallai/desktop-sdk` native binaries |

## Important Notes
- `@recallai/desktop-sdk` native binaries must be in `asarUnpack` — already configured in `package.json`
- Backend URL is hardcoded to production (`saleside-back-20-production.up.railway.app`) — desktop always calls prod
- `contextIsolation: true`, `nodeIntegration: false` — all Node access goes through `preload.js`
- On Windows, SDK requires no additional permissions; macOS requires accessibility + microphone + screen-capture
- The mode-choice modal in LiveCall lets user pick "Record Locally" (SDK) or "Bot Join" on desktop; web always uses bot join
