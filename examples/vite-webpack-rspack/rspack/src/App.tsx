import React from 'react';
import ReactDOM from 'react-dom/client';
import RspackImage from './Image';

import './index.css';

const App = () => (
  <div className="mt-10 text-3xl mx-auto text-white h-[80vh] bg-black max-w-6xl">
    <div>Name: rspack</div>
    <div>Framework: react</div>
    <div>Language: TypeScript</div>
    <div>CSS: Tailwind</div>
    <RspackImage />
  </div>
);
const rootElement = document.getElementById('app');
if (!rootElement) throw new Error('Failed to find the root element');

const root = ReactDOM.createRoot(rootElement as HTMLElement);

root.render(<App />);
