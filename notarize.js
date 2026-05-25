const { execSync } = require('child_process');
const path = require('path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;
  if (!process.env.CI) {
    console.log('Skipping notarization — not in CI');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  // Store credentials in keychain so notarytool pre-fetches an auth token.
  // This avoids a second auth network call during status polling, which is
  // the call that fails with Code=-1009 on macOS 15 runners.
  execSync(
    `xcrun notarytool store-credentials "NOTARIZE_PROFILE" ` +
    `--apple-id "${process.env.APPLE_ID}" ` +
    `--password "${process.env.APPLE_APP_SPECIFIC_PASSWORD}" ` +
    `--team-id "${process.env.APPLE_TEAM_ID}"`,
    { stdio: 'inherit' }
  );

  console.log(`Notarizing ${appPath}...`);
  execSync(
    `xcrun notarytool submit "${appPath}" --keychain-profile "NOTARIZE_PROFILE" --wait`,
    { stdio: 'inherit', timeout: 20 * 60 * 1000 }
  );

  console.log(`Stapling ${appPath}...`);
  execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' });
};
