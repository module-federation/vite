import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getReactIslandExposes, isReactComponentSource } from '../reactIsland';
import { getDefaultMockOptions } from './helpers';

const temporaryDirectories: string[] = [];

function temporaryProject() {
  const directory = mkdtempSync(path.join(tmpdir(), 'mf-react-island-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('react island source classification', () => {
  it('recognizes default React components but not non-UI or named-only modules', () => {
    expect(
      isReactComponentSource(
        `import React from 'react'; export default function Button() { return <button /> }`,
        'Button.tsx'
      )
    ).toBe(true);
    expect(
      isReactComponentSource(`export default function value() { return 42 }`, 'value.ts')
    ).toBe(false);
    expect(
      isReactComponentSource(`export function Button() { return <button /> }`, 'Button.tsx')
    ).toBe(false);
  });

  it('follows a simple local default re-export in island mode and disables islands when react is shared', () => {
    const root = temporaryProject();
    writeFileSync(
      path.join(root, 'Button.tsx'),
      `export default function Button() { return <button /> }`
    );
    writeFileSync(path.join(root, 'index.ts'), `export { default } from './Button'`);

    const options = getDefaultMockOptions({
      exposes: { './Button': { import: './index.ts' } as any },
      experiments: {
        externalRuntime: false,
        provideExternalRuntime: false,
        ssrMode: 'ISLAND',
      },
    });
    expect([...getReactIslandExposes(options, root)]).toEqual(['./Button']);

    options.shared.react = {} as any;
    expect([...getReactIslandExposes(options, root)]).toEqual([]);
  });

  it('does not classify exposes when experiments.ssrMode is absent', () => {
    const root = temporaryProject();
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'plain-vite-remote' }));
    writeFileSync(
      path.join(root, 'Button.tsx'),
      `export default function Button() { return <button /> }`
    );

    const options = getDefaultMockOptions({
      exposes: { './Button': { import: './Button.tsx' } as any },
    });
    expect([...getReactIslandExposes(options, root)]).toEqual([]);
  });
});
