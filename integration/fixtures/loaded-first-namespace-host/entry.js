import * as remoteUtil from 'remote1/Module';

export const name = remoteUtil.REMOTE_NAME;
document.querySelector('#app').textContent = name;
console.log('__mf_host_entry_evaluated__');
