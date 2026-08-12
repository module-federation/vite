import { hydrateRoot } from 'react-dom/client';
import App from './App';

// Await the federated module before hydrating so the client tree matches the
// server-rendered tree (no Suspense fallback mismatch).
const { default: RemoteWidget } = await import('ssrRemote/Widget');

hydrateRoot(document.getElementById('root'), <App RemoteWidget={RemoteWidget} />);
