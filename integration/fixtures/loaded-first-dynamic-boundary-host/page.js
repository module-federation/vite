import { REMOTE_NAME } from 'remote1/Module';

// Read at module top level: throws if the chunk evaluates before the remote is ready.
export const LABEL = REMOTE_NAME.toUpperCase();

export function render() {
  document.querySelector('#app').textContent = `${REMOTE_NAME} ${LABEL}`;
}
