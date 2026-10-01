import { named } from 'esm-dep';
import esmDefault from 'esm-default-dep';
import cjs from 'cjs-dep';

const { Widget } = await import('importMapRemote/Widget');

document.getElementById('app').textContent = [
  named,
  esmDefault,
  cjs.cjs,
  new Widget().render(),
].join(',');
