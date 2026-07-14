import { useState } from 'react';
import './index.css';

export default function MessageCard() {
  const [count, setCount] = useState(0);

  return (
    <article className="card">
      <p className="tag">runtimeRemote/MessageCard</p>
      <h3>Remote component mounted</h3>
      <p>
        Built with <code>@module-federation/vite</code>, discovered through the runtime manifest,
        rendered inside the host app.
      </p>
      <button data-testid="runtime-remote-counter" onClick={() => setCount((value) => value + 1)}>
        count: {count}
      </button>
    </article>
  );
}
