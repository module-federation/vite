import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
// This workspace package supplies react-dom 19, whose server.browser entry opens
// a module-scope MessageChannel when required.
const FIXTURE_PARENT = path.join(REPO_ROOT, 'examples/vite-vite/vite-remote');
const VITE_CLI = path.join(REPO_ROOT, 'node_modules/vite/bin/vite.js');
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('shared export detection side effects (#1003)', () => {
  it('exits after building with host-provided react-dom', { timeout: 20_000 }, async () => {
    const root = await mkdtemp(path.join(FIXTURE_PARENT, '.issue-1003-'));
    cleanup.push(root);
    await mkdir(path.join(root, 'src'));

    await Promise.all([
      writeFile(
        path.join(root, 'index.html'),
        '<div id="root"></div><script type="module" src="/src/main.js"></script>\n'
      ),
      writeFile(
        path.join(root, 'src/main.js'),
        `import { renderToString } from 'react-dom/server.browser';
document.querySelector('#root').textContent = renderToString('ok');
`
      ),
      writeFile(
        path.join(root, 'vite.config.js'),
        `import { federation } from ${JSON.stringify(path.join(REPO_ROOT, 'src/index.ts'))};

export default {
  logLevel: 'silent',
  plugins: [federation({
    name: 'issue1003Remote',
    filename: 'remoteEntry.js',
    exposes: { './main': './src/main.js' },
    dts: false,
    shared: {
      react: { singleton: true, import: false },
      'react-dom': { singleton: true, import: false },
    },
  })],
};
`
      ),
    ]);

    const output: string[] = [];
    const child = spawn(process.execPath, [VITE_CLI, 'build'], {
      cwd: root,
      env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => output.push(String(chunk)));
    child.stderr?.on('data', (chunk) => output.push(String(chunk)));

    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const [exitCode, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    clearTimeout(timeout);

    expect(signal, `build did not exit; output:\n${output.join('')}`).toBeNull();
    expect(exitCode, output.join('')).toBe(0);
  });
});
