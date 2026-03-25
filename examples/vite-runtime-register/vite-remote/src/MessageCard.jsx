import './index.css';

export default function MessageCard() {
  return (
    <article className="card">
      <p className="tag">runtimeRemote/MessageCard</p>
      <h3>Remote component mounted</h3>
      <p>
        Built with <code>@module-federation/vite</code>, discovered through the
        runtime manifest, rendered inside the host app.
      </p>
    </article>
  );
}
