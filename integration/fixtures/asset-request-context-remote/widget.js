import './widget.css';
import { label } from './label.js';

export async function render() {
  const { lazyText } = await import('./lazy.js');
  return `${label} ${lazyText}`;
}
