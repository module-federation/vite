import { useState } from 'react';

export default function Widget() {
  const [count, setCount] = useState(0);

  return (
    <section>
      <h2>SSR remote widget</h2>
      <button type="button" onClick={() => setCount((current) => current + 1)}>
        Remote count: {count}
      </button>
    </section>
  );
}
