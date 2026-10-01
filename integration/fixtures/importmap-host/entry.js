import { named } from 'esm-dep';
import esmDefault from 'esm-default-dep';
import cjs from 'cjs-dep';

document.getElementById('app').textContent = [named, esmDefault, cjs.cjs].join(',');
