import { useState } from 'react';
import {
  loadRuntimeComponent,
  loadRuntimeMessage,
  registerRuntimeRemote,
  remoteEntryUrl,
} from './runtime';
import './index.css';

export default function App() {
  const [registered, setRegistered] = useState(false);
  const [message, setMessage] = useState('Remote not loaded yet.');
  const [RemoteCard, setRemoteCard] = useState(null);
  const [error, setError] = useState('');

  const onRegister = () => {
    try {
      registerRuntimeRemote();
      setRegistered(true);
      setError('');
      setMessage(`Registered runtimeRemote -> ${remoteEntryUrl}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onLoadMessage = async () => {
    try {
      const nextMessage = await loadRuntimeMessage();
      setError('');
      setMessage(nextMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onLoadComponent = async () => {
    try {
      const nextComponent = await loadRuntimeComponent();
      setError('');
      setRemoteCard(() => nextComponent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Pure Runtime Host</p>
        <h1>Register a Vite remote at runtime</h1>
        <p className="lede">
          No static federation config in the host. The app creates a runtime
          instance, registers React as shared, then adds the remote on demand.
        </p>
      </section>

      <section className="panel flow">
        <div className="step">
          <span>1</span>
          <div>
            <h2>Register remote</h2>
            <p>{remoteEntryUrl}</p>
          </div>
          <button onClick={onRegister}>registerRemotes()</button>
        </div>

        <div className="step">
          <span>2</span>
          <div>
            <h2>Load exposed data</h2>
            <p>Calls `loadRemote('runtimeRemote/message')`.</p>
          </div>
          <button disabled={!registered} onClick={onLoadMessage}>
            loadRemote() data
          </button>
        </div>

        <div className="step">
          <span>3</span>
          <div>
            <h2>Load exposed component</h2>
            <p>Calls `loadRemote('runtimeRemote/MessageCard')`.</p>
          </div>
          <button disabled={!registered} onClick={onLoadComponent}>
            loadRemote() component
          </button>
        </div>
      </section>

      <section className="panel output">
        <h2>Status</h2>
        <pre>{message}</pre>
        {error ? <pre className="error">{error}</pre> : null}
      </section>

      <section className="panel output">
        <h2>Remote render</h2>
        {RemoteCard ? <RemoteCard /> : <p>Load the remote component to render it here.</p>}
      </section>
    </main>
  );
}
