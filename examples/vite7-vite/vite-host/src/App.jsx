import R from 'react';
import RD from 'react-dom/client';

import App from '@namespace/vite7ViteRemote';
import { AgGridDemo } from '@namespace/vite7ViteRemote/AgGridDemo';
import App1 from '@namespace/vite7ViteRemote/App1';
import { App2 } from '@namespace/vite7ViteRemote/App2';
import { EmotionDemo } from '@namespace/vite7ViteRemote/EmotionDemo';
import { MuiDemo } from '@namespace/vite7ViteRemote/MuiDemo';
import StyledDemo from '@namespace/vite7ViteRemote/StyledDemo';
import { ref } from 'vue';

console.log('Share Vue', ref);
console.log('Share React', R, RD);

export default function () {
  return (
    <div style={{ background: 'lightgray' }}>
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
    </div>
  );
}
