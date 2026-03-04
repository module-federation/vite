import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type PackageJson = {
  dependencies?: Record<string, string>;
};

const packageJsonPath = new URL('../../../package.json', import.meta.url);
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;

describe('package dependency guardrails', () => {
  it('keeps module federation core dependencies on 2.x to avoid Windows TYPE-001 regressions', () => {
    const dependencies = packageJson.dependencies ?? {};

    expect(dependencies['@module-federation/dts-plugin']).toMatch(/^\^2\./);
    expect(dependencies['@module-federation/runtime']).toMatch(/^\^2\./);
    expect(dependencies['@module-federation/sdk']).toMatch(/^\^2\./);
  });
});
