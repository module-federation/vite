import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';

const Product = lazy(() => import('remote/Product'));

// Keeps the host shell mounted when the remote expose throws, so the e2e spec can
// tell "host never bootstrapped" (init deadlock) apart from "remote failed".
class RemoteBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return <p data-testid="remote-error">{String(this.state.error.message || this.state.error)}</p>;
    }
    return this.props.children;
  }
}

function App() {
  return (
    <div>
      <h1 data-testid="host-ready">bundler host up</h1>
      <RemoteBoundary>
        <Suspense fallback={<p>loading remote product...</p>}>
          <Product />
        </Suspense>
      </RemoteBoundary>
    </div>
  );
}

createRoot(document.getElementById('app')).render(<App />);
