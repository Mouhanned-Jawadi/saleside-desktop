# SaleSide Desktop Release Guide (Simple)

## 1) Commit and push desktop changes
From the desktop repo root:

git add .
git commit -m "Desktop release v1.0.0"
git push origin main

## 2) Build Windows installer locally
npm install
npm run dist

Installer output:
release/SaleSide Setup 1.0.0.exe

## 3) Create GitHub Release
1. Open your desktop repo on GitHub
2. Go to Releases -> Draft a new release
3. Tag version: v1.0.0
4. Title: SaleSide Desktop v1.0.0
5. Upload file: release/SaleSide Setup 1.0.0.exe
6. Publish release

## 4) Copy direct download link
Use this format:
https://github.com/<owner>/<repo>/releases/latest/download/SaleSide%20Setup%201.0.0.exe

## 5) Add link to web app env
In frontend env:
VITE_DESKTOP_WINDOWS_DOWNLOAD_URL=https://github.com/<owner>/<repo>/releases/latest/download/SaleSide%20Setup%201.0.0.exe

Then rebuild/redeploy frontend so the download button points to your latest desktop release.
