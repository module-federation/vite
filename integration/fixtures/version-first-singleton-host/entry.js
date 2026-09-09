import sharedLib from 'shared-lib';

window.__host_saw_version__ = sharedLib.getVersion();

const { REMOTE_SHARED_VERSION } = await import('remote1/Module');
window.__remote_saw_version__ = REMOTE_SHARED_VERSION;

document.querySelector('#app').textContent =
  `host:${window.__host_saw_version__} remote:${window.__remote_saw_version__}`;
console.log('__mf_host_entry_evaluated__');
