async function loadHostChunk() {
  // Kept as a bare import() so Vite's preload helper, and its vite:preloadError,
  // sits between the import and the handling below.
  const module = await import('./hostChunk.js');
  return module ? 'loaded' : 'undefined';
}

import('remote1/Widget')
  .then((widget) => widget.render())
  .then(async (text) => {
    const app = document.querySelector('#app');
    app.className = 'asset-request-context-widget';
    app.textContent = text;
    // A host chunk unrelated to the remote. One test deletes it: its failed import
    // must still reject after the blob loader is in use.
    app.dataset.hostChunk = await loadHostChunk().catch(() => 'rejected');
  });
