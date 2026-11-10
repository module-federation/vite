import { init } from 'mock-shared-dep';
import { label } from './widget/dist/index.js';

export const render = () => {
  document.querySelector('#app').textContent = label(typeof init);
};
