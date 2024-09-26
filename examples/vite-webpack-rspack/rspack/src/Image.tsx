import React from 'react';
import { useState } from 'react';
import logo from './assets/rspack-logo.png';

const RspackImage = () => {
  const [count, setCount] = useState(0);
  return (
    <div className="flex flex-col gap-4 max-w-64">
      <p className="text-white text-base">This is a component from Rspack.</p>
      <button
        className="border rounded-md bg-orange-500/60 py-1 px-2 text-base"
        onClick={() => setCount(count + 1)}
      >
        <p>Button from Rspack - Count {count}</p>
      </button>
      <img src={logo} />
    </div>
  );
};

export default RspackImage;
