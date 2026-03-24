import React from 'react';

export function SharedCounter({ label = 'Shared Counter' }) {
  const [count, setCount] = React.useState(0);
  return (
    <div style={{ background: '#e0f2fe', padding: 16, borderRadius: 8, margin: 8 }}>
      <strong>{label}</strong>
      <button onClick={() => setCount((c) => c + 1)} style={{ marginLeft: 8 }}>
        count: {count}
      </button>
    </div>
  );
}

export function formatLabel(text) {
  return `[shared-lib] ${text}`;
}
