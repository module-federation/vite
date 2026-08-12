import { useEffect } from 'react';

export default function App({ RemoteWidget }) {
  // Signals tests that hydration has committed and event handlers are
  // attached — the flag reflects commit, not scheduling. Clicks before this
  // point would land on inert server-rendered markup.
  useEffect(() => {
    document.body.dataset.hydrated = 'true';
  }, []);
  return (
    <main>
      <h1>SSR host</h1>
      <RemoteWidget />
    </main>
  );
}
