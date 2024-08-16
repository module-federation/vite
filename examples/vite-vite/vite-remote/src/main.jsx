import React from 'react';
import ReactDOM from 'react-dom/client';
import { AgGridDemo } from './AgGridDemo';
import App1 from './App1';
import { App2 } from './App2';
import { EmotionDemo } from './EmotionDemo';
import { MuiDemo } from './MuiDemo';
import StyledDemo from './StyledDemo';


const root = ReactDOM.createRoot(document.getElementById('app'));
root.render(
  <React.StrictMode>
    <h1>MF Remote as standalone app</h1>

    <p>
      Vite React (v {React.version}) app running from Remote in{' '}
      <i> {import.meta.env.DEV ? ' Dev ' : ' prod '} mode </i>
    </p>
    <hr />

    <h2>App1</h2>
    <App1 />

    <h2>App2</h2>
    <App2 />

    <h2>AgGridDemo</h2>
    <AgGridDemo />

    <h2>MuiDemo</h2>
    <MuiDemo />

    <h2>Styled Components Demo</h2>
    <StyledDemo />

    <h2>Emotion Styled Components Demo</h2>
    <EmotionDemo />
  </React.StrictMode>
);
