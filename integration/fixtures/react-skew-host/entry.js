import { createRoot } from 'react-dom/client';

import('remote/Module').then(({ RemoteComponent }) => {
  createRoot(document.querySelector('#app')).render(RemoteComponent);
});
