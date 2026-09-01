import { REMOTE_NAME } from 'remote1/Module';

document.querySelector('#app').textContent = REMOTE_NAME;
export const loadLazy = () => import('./lazy.js');
