import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';
import { createApp } from 'vue';
import VueHost from './VueHost.vue';

//@ts-ignore
const root = ReactDOM.createRoot(document.getElementById('app'));
root.render(
  <React.StrictMode>
    <h1>React host component</h1>
    <App />
  </React.StrictMode>
);

const vapp = createApp(VueHost)
vapp.mount('#vue-app')
