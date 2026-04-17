# SaleSide Desktop Release Guide

## 1) Commit and push desktop changes

```bash
git add .
git commit -m "Desktop release v1.0.0"
git push origin main
```

## 2) Build Windows installer locally

```bash
npm install
npm run dist
```

Outputs in `release/`:
- `SaleSide Setup 1.0.0.exe` — standard NSIS installer
- `SaleSide-Portable-1.0.0.exe` — portable single-file exe (no install needed)

> **Offer both files in every GitHub Release.** Users blocked by AV or without admin
> rights can use the portable version without any installation step.

## 3) Create GitHub Release

1. Go to your repo on GitHub → Releases → Draft a new release
2. Tag: `v1.0.0`  Title: `SaleSide Desktop v1.0.0`
3. Upload **both** files: `SaleSide Setup 1.0.0.exe` and `SaleSide-Portable-1.0.0.exe`
4. Publish release

## 4) Update the frontend download URL

```
VITE_DESKTOP_WINDOWS_DOWNLOAD_URL=https://github.com/<owner>/<repo>/releases/latest/download/SaleSide%20Setup%201.0.0.exe
```

Rebuild and redeploy the frontend.

---

## Code Signing (eliminates all AV/SmartScreen blocks — do this ASAP)

Without a code signing certificate every Windows user sees "Windows protected your PC"
(SmartScreen) and many AV tools will quarantine the installer. **This is the only
complete fix.**

### Step 1 — Buy a certificate

Get an **OV (Organization Validation)** or **EV (Extended Validation)** certificate:

| Provider | Type | Cost/yr | SmartScreen |
|---|---|---|---|
| Sectigo | OV | ~$200 | Builds reputation over time |
| DigiCert | OV | ~$400 | Builds reputation over time |
| SSL.com | EV | ~$300 | **Instant SmartScreen trust** ← recommended |
| DigiCert | EV | ~$500 | Instant SmartScreen trust |

EV certificates are stored on a hardware USB token (YubiKey/SafeNet). They cost slightly
more but get instant SmartScreen reputation — meaning zero "Windows protected your PC"
warnings from day one.

### Step 2 — Export the certificate

Export the `.p12` / `.pfx` file (PKCS#12 format) from your certificate provider.
Keep the password safe — you'll need it at build time.

### Step 3 — Configure electron-builder

electron-builder reads code signing config from **environment variables** so the cert
never lives in the repo:

```bash
# Set these in your shell or CI secrets before running npm run dist:signed
export CSC_LINK=/path/to/certificate.p12      # or base64-encoded cert string
export CSC_KEY_PASSWORD=your-cert-password
```

Then build:

```bash
npm run dist:signed
# (identical to npm run dist — electron-builder auto-signs when CSC_LINK is set)
```

For GitHub Actions, add `CSC_LINK` (base64) and `CSC_KEY_PASSWORD` as repository secrets
and set them as env vars in the workflow.

### Step 4 — After signing, submit for AV whitelisting

Even signed apps can be flagged initially. Submit to major vendors:

- Windows Defender: https://www.microsoft.com/en-us/wdsi/filesubmission
- Malwarebytes: https://forums.malwarebytes.com/forum/122-false-positives/
- Norton: https://submit.norton.com/
- Avast: https://www.avast.com/false-positive-file-form.php

---

## What was fixed to reduce AV false positives (unsigned builds)

1. `installer.nsh` — removed `/F` (force-kill) and `/T` (tree-kill) flags from `taskkill`.
   Those flags are a textbook malware signature. The installer now sends a graceful
   WM_CLOSE signal instead.
2. `main.js` — added `--quit` CLI handler so the installer can ask the running app
   to close itself before overwriting files.
3. `package.json` — added `copyright`, `publisherName`, portable build target, and
   `differentialPackage: false` (prevents `.blockmap` files that some AV engines flag).
