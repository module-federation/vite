import React, { useState } from 'react';
import ProductHeader from './ProductHeader';
import ProductImage from './ProductImage';

export default () => {
  const [size, setSize] = useState('M');
  const [color, setColor] = useState('black');
  return (
    <div className="lg:grid lg:auto-rows-min lg:grid-cols-12 lg:gap-x-8">
      <ProductHeader />
      <ProductImage />
      <div className="mt-8 lg:col-span-5">
        <form>
          <div>
            <h2 className="text-sm font-medium text-gray-900">Color</h2>
            <div className="mt-2" role="radiogroup">
              <label className="sr-only" role="none">
                Choose a color
              </label>
              <div className="flex items-center space-x-3" role="none">
                <div
                  className={`ring-gray-900 ${color === 'black' ? 'ring-2' : ''} relative -m-0.5 flex cursor-pointer items-center justify-center rounded-full p-0.5 focus:outline-none`}
                  role="radio"
                  aria-checked="true"
                  onClick={() => setColor('black')}
                >
                  <span className="sr-only">Black</span>
                  <span
                    aria-hidden="true"
                    className="bg-gray-900 h-8 w-8 rounded-full border border-black border-opacity-10"
                  ></span>
                </div>
                <div
                  className={`ring-gray-400 ${color === 'grey' ? 'ring-2' : ''} relative -m-0.5 flex cursor-pointer items-center justify-center rounded-full p-0.5 focus:outline-none`}
                  role="radio"
                  aria-checked="false"
                  onClick={() => setColor('grey')}
                >
                  <span className="sr-only">Heather Grey</span>
                  <span
                    aria-hidden="true"
                    className="bg-gray-400 h-8 w-8 rounded-full border border-black border-opacity-10"
                  ></span>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-8">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-900">Size</h2>
              <a href="#" className="text-sm font-medium text-slate-600 hover:text-slate-500">
                See sizing chart
              </a>
            </div>
            <div
              className="mt-2"
              role="radiogroup"
              aria-labelledby="headlessui-label-:R1mhr4v5uba:"
            >
              <label className="sr-only" role="none">
                Choose a size
              </label>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-6" role="none">
                {['XS', 'S', 'M', 'L', 'XL', 'XXL'].map((s, i) => (
                  <div
                    key={i}
                    className={`cursor-pointer focus:outline-none ${s === size ? 'border-transparent bg-slate-600 text-white hover:bg-slate-700' : 'border-gray-200 bg-white text-gray-900 hover:bg-gray-50'} flex items-center justify-center rounded-md border py-3 px-3 text-sm font-medium uppercase sm:flex-1`}
                    role="radio"
                    aria-checked={s === size}
                    onClick={() => setSize(s)}
                  >
                    <span>{s}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <button
            type="submit"
            className="mt-8 flex w-full items-center justify-center rounded-md border border-transparent bg-slate-600 px-8 py-3 text-base font-medium text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('ADD_CART'));
            }}
          >
            Add to cart
          </button>
        </form>
        <div className="mt-10">
          <h2 className="text-sm font-medium text-gray-900">Description</h2>
          <div className="prose prose-sm mt-4 text-gray-500">
            <p>
              The Basic tee is an honest new take on a classic. The tee uses super soft, pre-shrunk
              cotton for true comfort and a dependable fit. They are hand cut and sewn locally, with
              a special dye technique that gives each tee it's own look.
            </p>
            <p>
              Looking to stock your closet? The Basic tee also comes in a 3-pack or 5-pack at a
              bundle discount.
            </p>
          </div>
        </div>
        <div className="mt-8 border-t border-gray-200 pt-8">
          <h2 className="text-sm font-medium text-gray-900">Fabric &amp; Care</h2>
          <div className="prose prose-sm mt-4 text-gray-500">
            <ul role="list">
              <li>Only the best materials</li>
              <li>Ethically and locally made</li>
              <li>Pre-washed and pre-shrunk</li>
              <li>Machine wash cold with similar colors</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};
