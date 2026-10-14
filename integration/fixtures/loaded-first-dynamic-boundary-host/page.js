import { REMOTE_NAME } from 'remote1/Module';

export function render() {
  document.querySelector('#app').textContent = String(REMOTE_NAME);
}
