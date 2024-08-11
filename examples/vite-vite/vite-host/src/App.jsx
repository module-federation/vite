import Mfapp01App from 'mfapp01/App';
import R from 'react';
import RD from 'react-dom/client';
import Remote2App from 'remote2/App';
import Button from 'remote3/button';

import { AgGridDemo } from 'viteViteRemote/AgGridDemo';
import App1 from 'viteViteRemote/App1';
import { App2 } from 'viteViteRemote/App2';
import { ref } from 'vue';

console.log('share vue', ref);
console.log('share React', R, RD);

export default function () {
  return (
    <div>
      Vite React
      <h2>Button</h2>
      <Button />
      <h2>Remote2App</h2>
      <Remote2App />
      <h2>Mfapp01App</h2>
      <Mfapp01App />
      <h2>Vite Remote App1</h2>
      <App1 />
      <h2>Vite Remote App2</h2>
      <App2 />
      <h2>Vite Remote AgGridDemo</h2>
      <AgGridDemo />
    </div>
  );
}
