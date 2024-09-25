import { init } from '@module-federation/runtime';

init({
  name: 'host',
  remotes: [],
});

import('./App');
