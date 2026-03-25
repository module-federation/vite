import React from 'react';

export type TCardVariant = 'default' | 'outlined';

export function SharedCounter({ label = 'Shared Counter' }: { label?: string }) {
  const [count, setCount] = React.useState(0);
  return (
    <div data-testid={`shared-counter-${label}`} style={{ background: '#e0f2fe', padding: 16, borderRadius: 8, margin: 8 }}>
      <strong>{label}</strong>
      <button onClick={() => setCount((c) => c + 1)} style={{ marginLeft: 8 }}>
        count: {count}
      </button>
    </div>
  );
}
