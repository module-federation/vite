import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

const RemoteButton = lazy(() => import('importMapRemote/Button'));

createRoot(document.getElementById('root')).render(
  <main>
    <h1>Host</h1>
    <Suspense fallback={<p>Loading remote…</p>}>
      <RemoteButton />
    </Suspense>
  </main>
);
