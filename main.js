const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

// Config
const PORT = 3000;
const API_URL = 'https://saleside-back-20-production.up.railway.app/';
const PROXY_PATHS = ['/api', '/auth', '/launch-bot', '/socket.io'];

let mainWindow;
let server;

function startServer() {
  const expressApp = express();

  // Determine dist path based on environment
  const distPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist')
    : path.join(__dirname, 'dist');

  // Serve static files from the 'dist' directory
  expressApp.use(express.static(distPath));

  // Proxy API requests
  PROXY_PATHS.forEach(pathPrefix => {
    expressApp.use(
      pathPrefix,
      createProxyMiddleware({
        target: API_URL,
        changeOrigin: true,
        ws: pathPrefix === '/socket.io', // Enable WebSocket support for socket.io
        logLevel: 'debug'
      })
    );
  });

  // Handle client-side routing, return all requests to index.html
  expressApp.get('*', (req, res) => {
    const distPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist')
      : path.join(__dirname, 'dist');
    res.sendFile(path.join(distPath, 'index.html'));
  });

  server = expressApp.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    createWindow();
  });
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const iconPath = path.join(__dirname, 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true, // Optional: hide the menu bar
  });

  // Load the app via the local server, forcing the login route
  mainWindow.loadURL(`http://localhost:${PORT}/login`);

  // Keep DevTools closed by default; opt in only when explicitly requested.
  if (process.env.SALESIDE_OPEN_DEVTOOLS === 'true') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
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
