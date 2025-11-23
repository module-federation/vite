import { PKGJsonManager } from '@module-federation/managers';
import { StatsBuildInfo } from '@module-federation/sdk';

/**copy from @module-federation/core */
export const LOCAL_BUILD_VERSION = 'local';

export function getBuildInfo(context?: string): StatsBuildInfo {
  const rootPath = context || process.cwd();
  // TODO: turn to singleton pattern if it is used by other code
  const pkgManager = new PKGJsonManager();

  const pkg = pkgManager.readPKGJson(rootPath);

  return {
    buildVersion: getBuildVersion(rootPath),
    buildName: getBuildName() || pkg['name'],
  };
}

export function getBuildVersion(root?: string): string {
  if (process.env['MF_BUILD_VERSION']) {
    return process.env['MF_BUILD_VERSION'];
  }
  const pkg = new PKGJsonManager().readPKGJson(root);
  if (pkg?.['version'] && typeof pkg['version'] === 'string') {
    return pkg['version'];
  }
  return LOCAL_BUILD_VERSION;
}

export function getBuildName(): string | undefined {
  return process.env['MF_BUILD_NAME'];
}
