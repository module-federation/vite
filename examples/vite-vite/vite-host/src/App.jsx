import Mfapp01App from 'mfapp01/App';
import R from 'react';
import RD from 'react-dom/client';
import Remote2App from 'remote2/App';
import Button from 'remote3/button';

import { AgGridDemo } from '@namespace/viteViteRemote/AgGridDemo';
import App1 from '@namespace/viteViteRemote/App1';
import { App2 } from '@namespace/viteViteRemote/App2';
import { MuiDemo } from '@namespace/viteViteRemote/MuiDemo';
import { ref } from 'vue';

console.log('Share Vue', ref);
console.log('Share React', R, RD);

export default function () {
  return (
    <div>
      <p>
        Vite React (v {R.version}) app running from Host in{' '}
        <i> {import.meta.env.DEV ? ' Dev ' : ' prod '} mode </i>
      </p>
      <hr />
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
      <h3>Vite Remote MuiDemo</h3>
      <MuiDemo />
    </div>
  );
}