// Used only as a type, so the TypeScript transform drops this import and the page loads no remote.
import { Label } from 'remote1/Module';

const label: Label = 'typed';

export function render() {
  document.querySelector('#app')!.textContent = label;
}
