import { init } from '@module-federation/enhanced/runtime';

init({
  name: 'host',
  remotes: [],
});

import('./App');
