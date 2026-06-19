const { execFileSync } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const PLIST_BUDDY = '/usr/libexec/PlistBuddy';

function plistBuddy(plistPath, command, allowFailure = false) {
  try {
    return execFileSync(PLIST_BUDDY, ['-c', command, plistPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function setString(plistPath, key, value) {
  plistBuddy(plistPath, `Delete :${key}`, true);
  plistBuddy(plistPath, `Add :${key} string ${value}`);
}

function setBool(plistPath, keyPath, value) {
  plistBuddy(plistPath, `Delete :${keyPath}`, true);
  plistBuddy(plistPath, `Add :${keyPath} bool ${value ? 'true' : 'false'}`);
}

function ensureDict(plistPath, key) {
  plistBuddy(plistPath, `Add :${key} dict`, true);
}

function patchLocalNetworkInfo(plistPath, localNetworkUsageDescription) {
  setString(plistPath, 'NSLocalNetworkUsageDescription', localNetworkUsageDescription);
  ensureDict(plistPath, 'NSAppTransportSecurity');
  setBool(plistPath, 'NSAppTransportSecurity:NSAllowsLocalNetworking', true);
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'linux') {
    const { chmodSync } = require('node:fs');
    const resourcesBin = join(context.appOutDir, 'resources', 'bin');
    for (const helper of ['LocalLinuxHelper.sh', 'atspi_helper.py']) {
      const p = join(resourcesBin, helper);
      if (existsSync(p)) chmodSync(p, 0o755);
    }
    return;
  }
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);
  const appInfoPlist = join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(appInfoPlist)) return;

  const localNetworkUsageDescription = plistBuddy(
    appInfoPlist,
    'Print :NSLocalNetworkUsageDescription',
    true,
  ) || `${context.packager.appInfo.productName} connects to services on your local network.`;

  const frameworksDir = join(appPath, 'Contents', 'Frameworks');
  if (!existsSync(frameworksDir)) return;

  for (const entry of readdirSync(frameworksDir)) {
    if (!entry.endsWith('.app')) continue;

    const helperInfoPlist = join(frameworksDir, entry, 'Contents', 'Info.plist');
    if (!existsSync(helperInfoPlist)) continue;

    patchLocalNetworkInfo(helperInfoPlist, localNetworkUsageDescription);
  }
};
