import React from 'react';
import { createRoot } from 'react-dom/client';

const root = createRoot(document.querySelector('#app'));
root.render(React.createElement('div', null, React.version));
