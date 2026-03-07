const path = require('path');
const { notarize } = require('@electron/notarize');

module.exports = async function notarizing(context) {
  if (process.platform !== 'darwin') return;

  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const appleId = process.env.APPLE_ID;
  const applePassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !applePassword || !teamId) {
    console.warn('[notarize] Missing Apple notarization env vars, skipping notarization.');
    return;
  }

  console.log(`[notarize] Submitting ${appName}.app for notarization...`);

  await notarize({
    tool: 'notarytool',
    appPath,
    appleId,
    appleIdPassword: applePassword,
    teamId
  });

  console.log('[notarize] Notarization complete.');
};
