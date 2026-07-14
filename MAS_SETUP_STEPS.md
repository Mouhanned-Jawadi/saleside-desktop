# MAS Setup — Step-by-Step Runbook (Windows, no Mac)

Everything here is done in a browser or in **Git Bash** on Windows. No Mac needed.
Work top to bottom. Keep a scratch folder, e.g. `C:\Users\MSI\mas-setup\`, and run
the `openssl` commands from there in Git Bash.

Find your **Team ID** first: https://developer.apple.com/account → **Membership** →
"Team ID" (10 chars like `A1B2C3D4E5`). You'll need it a couple of times.

---

## STEP 0 — Commit & push the code changes (required)

GitHub Actions runs the workflow from the pushed repo, so the new files must be on
the remote first (`build/entitlements.mas*.plist`, `package.json`, `build.yml`,
the guides). In the desktop repo:

```bash
git add build/entitlements.mas.plist build/entitlements.mas.inherit.plist \
        build/entitlements.mas.loginhelper.plist package.json \
        .github/workflows/build.yml MAS_DISTRIBUTION_GUIDE.md MAS_SETUP_STEPS.md
git commit -m "Add Mac App Store (MAS) build pipeline"
git push
```

---

## STEP 1 — App ID + macOS app record

### 1a. Register the App ID
1. https://developer.apple.com/account → **Certificates, Identifiers & Profiles** →
   **Identifiers** → the blue **➕**.
2. Select **App IDs** → **Continue** → type **App** → **Continue**.
3. **Description:** `SaleSide Desktop`. **Bundle ID:** choose **Explicit**, enter
   `com.saleside.desktop`.
4. Leave all capabilities unchecked (App Sandbox is not a capability here) →
   **Continue** → **Register**.

### 1b. Create the macOS app record
1. https://appstoreconnect.apple.com → **Apps** → the blue **➕** → **New App**.
2. **Platforms:** check **macOS**. **Name:** `SaleSide`. **Primary language:** English.
3. **Bundle ID:** pick `com.saleside.desktop` from the dropdown.
4. **SKU:** anything unique, e.g. `saleside-desktop-mac`. **Create**.

---

## STEP 2 — Two MAS certificates + provisioning profile

### 2a. Make one private key + CSR (Git Bash)
```bash
cd ~/mas-setup   # or wherever
openssl genrsa -out mas.key 2048
openssl req -new -sha256 -key mas.key -out mas.csr \
  -subj "/CN=SaleSide Mac App Store/emailAddress=mouhanned.j18@gmail.com/C=TN"
```
Keep `mas.key` safe — both certs are tied to it.

### 2b. Apple Distribution certificate (signs the .app)
1. Portal → **Certificates** → **➕**.
2. Under **Software** choose **Apple Distribution** → **Continue**.
3. Upload `mas.csr` → **Continue** → **Download**. Save as `apple_distribution.cer`.

### 2c. Mac Installer Distribution certificate (signs the .pkg)
1. Portal → **Certificates** → **➕**.
2. Under **Software** choose **Mac Installer Distribution** → **Continue**.
3. Upload the **same** `mas.csr` → **Continue** → **Download**. Save as
   `mac_installer.cer`.

### 2d. Bundle both certs + the key into one .p12 (Git Bash)
```bash
openssl x509 -inform DER -in apple_distribution.cer -out apple_distribution.pem
openssl x509 -inform DER -in mac_installer.cer      -out mac_installer.pem

openssl pkcs12 -export \
  -out mas_certs.p12 \
  -inkey mas.key \
  -in apple_distribution.pem \
  -certfile mac_installer.pem \
  -name "SaleSide MAS" \
  -passout pass:CHOOSE_A_STRONG_PASSWORD
```
Remember the password — it becomes the `MAS_CERTIFICATE_PASSWORD` secret.
> If the CI keychain import later fails with a format error, regenerate adding the
> `-legacy` flag to the `openssl pkcs12 -export` command.

### 2e. Mac App Store provisioning profile
1. Portal → **Profiles** → **➕**.
2. Under **Distribution** choose **Mac App Store Connect** (a.k.a. "Mac App Store") →
   **Continue**.
3. **App ID:** select `com.saleside.desktop`.
4. **Certificate:** select the **Apple Distribution** cert from 2b → **Continue**.
5. **Name:** `SaleSide MAS Profile` → **Generate** → **Download**. Save as
   `SaleSide_MAS.provisionprofile`.

---

## STEP 3 — App Store Connect API key (for uploading the build)

1. https://appstoreconnect.apple.com → **Users and Access** → **Integrations** tab →
   **App Store Connect API** → **➕** (Generate API Key / Team Keys).
2. **Name:** `CI Upload`. **Access:** **App Manager** → **Generate**.
3. Note the **Issuer ID** (top of the page, a UUID) and the row's **Key ID**.
4. **Download** the key — this gives `AuthKey_XXXXXXXX.p8`. **You can only download it
   once.** Save it next to your other files.

---

## STEP 4 — Add the 6 GitHub secrets

First base64-encode the three files (Git Bash), which prints/writes one-line text:
```bash
base64 -w0 mas_certs.p12               > mas_certs.p12.b64
base64 -w0 SaleSide_MAS.provisionprofile > profile.b64
base64 -w0 AuthKey_XXXXXXXX.p8         > authkey.b64
```

Then in the **desktop GitHub repo** → **Settings** → **Secrets and variables** →
**Actions** → **New repository secret**, add each of these:

| Secret name | Value |
|---|---|
| `MAS_CERTIFICATE_P12` | contents of `mas_certs.p12.b64` |
| `MAS_CERTIFICATE_PASSWORD` | the password you chose in 2d |
| `MAS_PROVISIONING_PROFILE_BASE64` | contents of `profile.b64` |
| `ASC_API_KEY_ID` | the Key ID from step 3 |
| `ASC_API_ISSUER_ID` | the Issuer ID from step 3 |
| `ASC_API_KEY_P8` | contents of `authkey.b64` |

To copy a `.b64` file's contents to the clipboard on Windows:
`Get-Content mas_certs.p12.b64 | Set-Clipboard` (PowerShell).

---

## STEP 5 — Run the build

1. GitHub repo → **Actions** → **Build Desktop App** → **Run workflow**.
2. Pick your branch, set **`build_mas`** = **true** (checkbox/dropdown) → **Run workflow**.
3. Open the run → watch the **`build-mac-mas`** job. Success = a signed `.pkg` built
   and `xcrun altool --upload-app` reports success.
4. Go to **App Store Connect → SaleSide (macOS) → TestFlight**. After Apple finishes
   processing (minutes to ~1 hour) the build appears there.

---

## STEP 6 — The actual test (this is the point of the spike)

You have no Mac, so add a **TestFlight tester who owns a Mac** (App Store Connect →
TestFlight → Internal/External testers). Have them install and answer:
- Does the app launch under the sandbox?
- Does meeting **recording** work, partly work, or fail?

**Go / no-go:** only proceed to a full App Store submission if recording works. If it
doesn't, the fallback is a **feature-limited MAS build** (disable live recording, keep
analytics / coaching / history / simulation) — ask and I'll wire that flag in.

---

## Troubleshooting

- **`No identity found` / signing fails in CI** → the `.p12` didn't contain both
  certs or the key. Re-do 2d; confirm `openssl pkcs12 -info -in mas_certs.p12` lists
  the key plus both certificates.
- **electron-builder can't find the installer identity** → set it explicitly by
  adding `"identity": "Apple Distribution: <Your Name> (<TeamID>)"` under `build.mas`
  in `package.json`, and ensure the installer cert is `3rd Party Mac Developer
  Installer` / `Mac Installer Distribution`.
- **`altool` rejects the build (bundle version / ITMS errors)** → bump `version` in
  `package.json`; each upload needs a unique version/build number.
- **Provisioning profile mismatch** → the profile's App ID and selected cert must be
  the exact ones from steps 1a/2b; regenerate if you recreated the cert.
