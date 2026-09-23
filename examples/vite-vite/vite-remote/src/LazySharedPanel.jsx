import lazySharedMessage from '@vite-vite/shared-lazy';

// Top-level use: the share has to be bridged before this chunk evaluates.
const message = lazySharedMessage();

export default function LazySharedPanel() {
  return <p data-testid="lazy-shared-panel">{message}</p>;
}
