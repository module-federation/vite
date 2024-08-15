import React from 'react';
import ReactDOM from 'react-dom/client';
import { AgGridDemo } from './AgGridDemo';
import App1 from './App1';
import { App2 } from './App2';
import { MuiDemo } from './MuiDemo';


const root = ReactDOM.createRoot(document.getElementById('app'));
root.render(
  <React.StrictMode>
    <h1>MF Remote as standalone app</h1>

    <h2>App1</h2>
    <App1 />

    <h2>App2</h2>
    <App2 />

    <h2>AgGridDemo</h2>
    <AgGridDemo />

    <h2>MuiDemo</h2>
    <MuiDemo />
  </React.StrictMode>
);
