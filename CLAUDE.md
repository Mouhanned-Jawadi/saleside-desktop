# SaleSide Desktop App — Claude Code Context

## Stack
Electron 28 / Express.js (internal proxy) / http-proxy-middleware / electron-builder

## Entry Point
`main.js` — Electron main process

## How It Works
1. Starts an Express server on localhost:3000
2. Serves the built React frontend (`SaleSide-Front-2.0/dist/`)
3. Proxies `/api/*` and `/socket.io/*` to the production backend URL
4. Opens Electron BrowserWindow pointing to localhost:3000

## Build Output
Windows NSIS installer (`.exe`) via electron-builder.

## Commands
```bash
npm install
npm start              # Dev mode
npm run build          # Build Windows installer
```

## Important
- Must build the React frontend first before running the desktop app
- Backend URL is hardcoded to production — desktop app is always a production client
- Creates desktop shortcuts on install
