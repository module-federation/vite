import { lazy, Suspense, useState } from 'react';

// `@vite-vite/shared-lazy` is only imported by this lazily loaded panel, so the
// remote's init() must leave it to the host until the panel is requested.
const LazySharedPanel = lazy(() => import('./LazySharedPanel.jsx'));

export default function LazySharedDemo() {
  const [showPanel, setShowPanel] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setShowPanel(true)}>
        Show lazy shared panel
      </button>
      {showPanel && (
        <Suspense fallback={<p>loading lazy shared panel…</p>}>
          <LazySharedPanel />
        </Suspense>
      )}
    </div>
  );
}
