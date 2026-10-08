// electron-builder afterSign hook: notarizes the macOS build with Apple.
//
// Skips itself (with a warning, not a failure) unless the required
// environment variables are present, so `npm run dist:mac` still works for
// local/dev builds without Apple credentials. Wire these up as CI secrets
// for real release builds:
//
//   APPLE_ID                 - your Apple ID email
//   APPLE_APP_SPECIFIC_PASSWORD - an app-specific password for that Apple ID
//                                 (generate at https://appleid.apple.com)
//   APPLE_TEAM_ID             - your Apple Developer Team ID
//
// electron-builder's mac signing (CSC_LINK / CSC_KEY_PASSWORD env vars, or a
// configured `mac.identity`) must also be set up separately — notarization
// only works on a build that was already code-signed with a valid
// "Developer ID Application" certificate.
const { notarize } = require('@electron/notarize');

module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.warn(
      '[notarize] Skipping notarization: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / ' +
        'APPLE_TEAM_ID are not all set. The resulting .dmg will NOT be notarized ' +
        'and Gatekeeper will warn/block users who download it. Set these env vars ' +
        '(and a valid Developer ID Application signing identity) before shipping a release.'
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;

  console.log(`[notarize] Submitting ${appName} for notarization — this can take several minutes...`);
  await notarize({
    appBundleId: 'org.rozh.encoder',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID
  });
  console.log(`[notarize] ${appName} notarized successfully.`);
};
