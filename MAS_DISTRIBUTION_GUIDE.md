# Mac App Store (MAS) Distribution Guide

This documents the **Mac App Store** pipeline for SaleSide Desktop. It is **separate
from** and **additive to** the existing notarized `.dmg` pipeline (Developer ID +
`notarize.js`), which is unchanged and keeps producing the direct-download build.

> **You do not need a Mac.** Every Mac step runs in GitHub Actions `macos-14`
> runners. From Windows you only edit config, manage GitHub secrets, and do
> browser-based App Store Connect / Developer-portal steps.

---

## ⚠️ Read this first — App Sandbox feasibility

The Mac App Store **requires App Sandbox**. App Sandbox **forbids** the entitlements
the DMG build relies on (`cs.disable-library-validation`,
`cs.allow-unsigned-executable-memory`, `cs.allow-jit`, dyld env vars), and heavily
restricts system-audio / screen capture and loopback servers.

This app:
- loads the **Recall native desktop SDK** (unpacked native binaries), and
- runs a **local Express server on `localhost:3000`**, and
- captures **system/meeting audio**.

All three are exactly what the sandbox constrains. **The core recording feature may
not work — or may be rejected in review — under the sandbox.** Treat the first MAS
build as a **feasibility spike**, not a release:

1. Run the `build-mac-mas` job (below) to produce and upload a `.pkg`.
2. Distribute via **macOS TestFlight** to a tester **who owns a Mac** (you have none).
3. Confirm: does the app launch? Does recording work / partly work / fail?
4. **Go / no-go:** only pursue a real App Store submission if it works. Otherwise
   ship a **feature-limited MAS build** (disable live recording; keep analytics,
   coaching, history, simulation) or keep MAS off the table and rely on the DMG.

---

## One-time prerequisites (browser + Windows only)

1. **Apple Developer Program** — already active (iOS "Co-Pilot" app exists).
2. **Register the App ID** `com.saleside.desktop` (explicit) in the Developer portal,
   then **create the macOS app record** in App Store Connect for it. App Sandbox is
   enabled via the entitlements plist (already done) — it is **not** a portal
   capability, so there is nothing to toggle on the identifier for the spike.
3. **Two MAS signing certificates** (different from the Developer ID cert):
   - **Apple Distribution** — signs the `.app`
   - **Mac Installer Distribution** ("3rd Party Mac Developer Installer") — signs `.pkg`
   Easiest without a Mac: create them via the **App Store Connect API** (Certificates
   endpoint) or **fastlane** (`match` / `cert` + `sigh`) run inside the macOS CI job.
   You can also generate the CSR with `openssl` in Git Bash on Windows, upload it in
   the portal, download the `.cer`, and export a combined `.p12` with `openssl`.
4. **App Store provisioning profile** (type: **Mac App Store**) for the bundle id.
5. **App Store Connect API key** — Issuer ID, Key ID, and the `.p8` file
   (Users and Access → Integrations → App Store Connect API).

## GitHub secrets to add

Add alongside the existing Developer-ID secrets (`CERTIFICATE_P12`, `APPLE_ID`, …):

| Secret | What it is |
|---|---|
| `MAS_CERTIFICATE_P12` | base64 of a `.p12` containing **both** MAS certs + private keys |
| `MAS_CERTIFICATE_PASSWORD` | password for that `.p12` |
| `MAS_PROVISIONING_PROFILE_BASE64` | base64 of the `.provisionprofile` |
| `ASC_API_KEY_ID` | App Store Connect API Key ID |
| `ASC_API_ISSUER_ID` | App Store Connect API Issuer ID |
| `ASC_API_KEY_P8` | base64 of the `AuthKey_XXXX.p8` file |
| `APPLE_TEAM_ID` | *(already exists)* — used to fill the app-group entitlement |

To base64-encode on Windows (Git Bash): `base64 -w0 file.p12 > file.p12.b64`.

## Running the build

GitHub → Actions → **Build Desktop App** → **Run workflow** → set
**`build_mas` = true**. This triggers the `build-mac-mas` job only; normal
push/tag builds never run it.

The job (in `.github/workflows/build.yml`):
1. builds the frontend and copies it into `dist/`,
2. substitutes `APPLE_TEAM_ID` into `__TEAM_ID__` in `build/entitlements.mas.plist`,
3. imports the MAS certs and installs the provisioning profile,
4. runs `npx electron-builder --mac mas` → signed `.pkg` in `release/`,
5. uploads the `.pkg` to App Store Connect via `xcrun altool --upload-app`.

After upload, the build appears under **App Store Connect → your macOS app →
TestFlight** once Apple finishes processing (minutes to ~1 hour).

## Relevant files

| File | Role |
|---|---|
| `build/entitlements.mas.plist` | Sandboxed app entitlements (`__TEAM_ID__` placeholder) |
| `build/entitlements.mas.inherit.plist` | Helper-process inherited entitlements |
| `build/entitlements.mas.loginhelper.plist` | Login-helper entitlements |
| `package.json` → `build.mas` | electron-builder MAS target config |
| `package.json` → `scripts.dist:mas` | `electron-builder --mac mas` |
| `.github/workflows/build.yml` → `build-mac-mas` | CI build + upload job |

The DMG/notarize path (`build/entitlements.mac.plist`, `notarize.js`, jobs
`build-mac-app` + `notarize-and-package`) is untouched and continues to work.
