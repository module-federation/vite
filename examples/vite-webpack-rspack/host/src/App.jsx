import { loadRemote } from '@module-federation/runtime';
import { lazy, StrictMode, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './App.css';
import reactLogo from './assets/react.svg';
import './index.css';
import viteLogo from '/vite.svg';

const RemoteButton = lazy(() => import('remote/Button'));
const WebpackButton = lazy(() => loadRemote('webpack/Image'));
const RspackImage = lazy(() => import('rspack/Image'));

function App() {
  const [count, setCount] = useState(0);

  return (
    <>
      <div>
        <Suspense fallback="Loading Button">
          <RemoteButton />
        </Suspense>
        <Suspense fallback="Loading Image">
          <WebpackButton />
        </Suspense>
        <Suspense fallback="Loading Image">
          <RspackImage />
        </Suspense>
      </div>
      <div>
        <a href="https://vitejs.dev" target="_blank">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <h1>Vite + React</h1>
      <div className="card">
        <button onClick={() => setCount((count) => count + 1)}>count is {count}</button>
        <p>
          Edit <code>src/App.jsx</code> and save to test HMR
        </p>
      </div>
      <p className="read-the-docs">Click on the Vite and React logos to learn more</p>
    </>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
