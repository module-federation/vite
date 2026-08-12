import { hydrateRoot } from 'react-dom/client';
import App from './App';

// Await the federated module before hydrating so the client tree matches the
// server-rendered tree (no Suspense fallback mismatch).
const { default: RemoteWidget } = await import('ssrRemote/Widget');

hydrateRoot(document.getElementById('root'), <App RemoteWidget={RemoteWidget} />);

// Signals tests that event handlers are attached; clicks before this point
// would land on inert server-rendered markup.
document.body.dataset.hydrated = 'true';
