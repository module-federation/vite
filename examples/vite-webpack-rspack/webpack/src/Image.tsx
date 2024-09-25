import React from 'react';
import { useState } from 'react';
import logo from './assets/webpack-logo.png';

const WebpackImage = () => {
  const [count, setCount] = useState(0);
  return (
    <div>
      <p className="text-white text-base">This is a component from Webpack.</p>{' '}
      <button
        className="border rounded-md text-base text-white py-1 px-2"
        onClick={() => setCount(count + 1)}
      >
        Webpack Button - Count: {count}
      </button>
      <img src={logo} />
    </div>
  );
};

export default WebpackImage;
