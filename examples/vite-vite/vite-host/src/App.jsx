import Mfapp01App from 'mfapp01/App';
import R from 'react';
import RD from 'react-dom/client';
import Remote2App from 'remote2/App';
import Button from 'remote3/button';

import App from '@namespace/viteViteRemote';
import { AgGridDemo } from '@namespace/viteViteRemote/AgGridDemo';
import App1 from '@namespace/viteViteRemote/App1';
import { App2 } from '@namespace/viteViteRemote/App2';
import { EmotionDemo } from '@namespace/viteViteRemote/EmotionDemo';
import { MuiDemo } from '@namespace/viteViteRemote/MuiDemo';
import StyledDemo from '@namespace/viteViteRemote/StyledDemo';
import { ref } from 'vue';

console.log('Share Vue', ref);
console.log('Share React', R, RD);

export default function () {
  return (
    <div style={{ background: "lightgray" }}>
      <p>
        Vite React (v {R.version}) app running from Host in{' '}
        <i> {import.meta.env.DEV ? ' Dev ' : ' prod '} mode </i>
      </p>
      <hr />



      <h2>Vite Remote Default App</h2>
      <App />

      <h2>Vite Remote App1</h2>
      <App1 />

      <h2>Vite Remote App2</h2>
      <App2 />

      <h2>Vite Remote AgGridDemo</h2>
      <AgGridDemo />

      <h3>Vite Remote MuiDemo</h3>
      <MuiDemo />

      <h2>Styled Components Demo</h2>
      <StyledDemo />

      <h2>Emotion Styled Components Demo</h2>
      <EmotionDemo />

      <hr />

      <h2>Button</h2>
      <Button />

      <h2>Remote2App</h2>
      <Remote2App />

      <h2>Mfapp01App</h2>
      <Mfapp01App />
    </div>
  );
}