import React from 'react';
import ReactDOM from 'react-dom';
import { createInstance } from '@module-federation/runtime';

const remoteEntryUrl =
  import.meta.env.VITE_REMOTE_ENTRY_URL ??
  'http://localhost:4176/mf-manifest.json';

const mf = createInstance({
  name: 'viteRuntimeRegisterHost',
  remotes: [],
});

mf.registerShared({
  react: {
    version: React.version,
    scope: 'default',
    lib: () => React,
    shareConfig: {
      singleton: true,
      requiredVersion: `^${React.version}`,
    },
  },
  'react-dom': {
    version: ReactDOM.version || React.version,
    scope: 'default',
    lib: () => ReactDOM,
    shareConfig: {
      singleton: true,
      requiredVersion: `^${ReactDOM.version || React.version}`,
    },
  },
});

export function registerRuntimeRemote() {
  mf.registerRemotes([
    {
      name: 'runtimeRemote',
      entry: remoteEntryUrl,
      type: 'module',
    },
  ]);
}

export async function loadRuntimeComponent() {
  const mod = await mf.loadRemote('runtimeRemote/MessageCard');
  return mod?.default ?? mod?.MessageCard ?? null;
}

export async function loadRuntimeMessage() {
  const mod = await mf.loadRemote('runtimeRemote/message');
  const getMessage = mod?.default ?? mod?.getMessage;

  return typeof getMessage === 'function' ? getMessage() : 'No message found.';
}

export { remoteEntryUrl };
