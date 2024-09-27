import React from 'react';
import './App.css';

export default () => {
  return (
    <div className="lg:grid lg:auto-rows-min lg:grid-cols-12 lg:gap-x-8">
      <div className="lg:col-span-5 lg:col-start-8">
        <div className="flex justify-between">
          <h1 className="text-xl font-medium text-gray-900">Basic Tee</h1>
          <p className="text-xl font-medium text-gray-900">35 €</p>
        </div>
        <div className="mt-4">
          <h2 className="sr-only">Reviews</h2>
          <div className="flex items-center">
            <p className="text-sm text-gray-700">
              3.9<span className="sr-only"> out of 5 stars</span>
            </p>
            <div className="ml-1 flex items-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                data-slot="icon"
                className="text-yellow-400 h-5 w-5 flex-shrink-0"
              >
                <path
                  fillRule="evenodd"
                  d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z"
                  clipRule="evenodd"
                ></path>
              </svg>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                data-slot="icon"
                className="text-yellow-400 h-5 w-5 flex-shrink-0"
              >
                <path
                  fillRule="evenodd"
                  d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z"
                  clipRule="evenodd"
                ></path>
              </svg>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                data-slot="icon"
                className="text-yellow-400 h-5 w-5 flex-shrink-0"
              >
                <path
                  fillRule="evenodd"
                  d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z"
                  clipRule="evenodd"
                ></path>
              </svg>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                data-slot="icon"
                className="text-yellow-400 h-5 w-5 flex-shrink-0"
              >
                <path
                  fillRule="evenodd"
                  d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z"
                  clipRule="evenodd"
                ></path>
              </svg>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                data-slot="icon"
                className="text-gray-200 h-5 w-5 flex-shrink-0"
              >
                <path
                  fillRule="evenodd"
                  d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z"
                  clipRule="evenodd"
                ></path>
              </svg>
            </div>
            <div aria-hidden="true" className="ml-4 text-sm text-gray-300">
              ·
            </div>
            <div className="ml-4 flex">
              <a href="#" className="text-sm font-medium text-slate-600 hover:text-slate-500">
                See all 512 reviews
              </a>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-8 lg:col-span-7 lg:col-start-1 lg:row-span-3 lg:row-start-1 lg:mt-0">
        <h2 className="sr-only">Images</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 lg:gap-8">
          <img
            alt="Back of women's Basic Tee in black."
            loading="lazy"
            width="1392"
            height="2088"
            decoding="async"
            data-nimg="1"
            className="lg:col-span-2 lg:row-span-2 rounded-lg"
            style={{ color: 'transparent' }}
            src="http://localhost:4001/product.webp"
          />
        </div>
      </div>
      <div className="mt-8 lg:col-span-5">
        <form>
          <div>
            <h2 className="text-sm font-medium text-gray-900">Color</h2>
            <div
              className="mt-2"
              id="headlessui-radiogroup-:R29r4v5uba:"
              role="radiogroup"
              aria-labelledby="headlessui-label-:R1m9r4v5uba:"
            >
              <label className="sr-only" id="headlessui-label-:R1m9r4v5uba:" role="none">
                Choose a color
              </label>
              <div className="flex items-center space-x-3" role="none">
                <div
                  className="ring-gray-900 ring-2 relative -m-0.5 flex cursor-pointer items-center justify-center rounded-full p-0.5 focus:outline-none"
                  id="headlessui-radiogroup-option-:R6m9r4v5uba:"
                  role="radio"
                  aria-checked="true"
                  data-headlessui-state="checked"
                  aria-labelledby="headlessui-label-:R1mm9r4v5uba:"
                >
                  <span className="sr-only" id="headlessui-label-:R1mm9r4v5uba:">
                    Black
                  </span>
                  <span
                    aria-hidden="true"
                    className="bg-gray-900 h-8 w-8 rounded-full border border-black border-opacity-10"
                  ></span>
                </div>
                <div
                  className="ring-gray-400 relative -m-0.5 flex cursor-pointer items-center justify-center rounded-full p-0.5 focus:outline-none"
                  id="headlessui-radiogroup-option-:Ram9r4v5uba:"
                  role="radio"
                  aria-checked="false"
                  data-headlessui-state=""
                  aria-labelledby="headlessui-label-:R1qm9r4v5uba:"
                >
                  <span className="sr-only" id="headlessui-label-:R1qm9r4v5uba:">
                    Heather Grey
                  </span>
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
              id="headlessui-radiogroup-:R2hr4v5uba:"
              role="radiogroup"
              aria-labelledby="headlessui-label-:R1mhr4v5uba:"
            >
              <label className="sr-only" id="headlessui-label-:R1mhr4v5uba:" role="none">
                Choose a size
              </label>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-6" role="none">
                <div
                  className="cursor-pointer focus:outline-none border-gray-200 bg-white text-gray-900 hover:bg-gray-50 flex items-center justify-center rounded-md border py-3 px-3 text-sm font-medium uppercase sm:flex-1"
                  id="headlessui-radiogroup-option-:R6mhr4v5uba:"
                  role="radio"
                  aria-checked="false"
                  data-headlessui-state=""
                  aria-labelledby="headlessui-label-:R16mhr4v5uba:"
                >
                  <span id="headlessui-label-:R16mhr4v5uba:">XXS</span>
                </div>
                <div
                  className="cursor-pointer focus:outline-none border-gray-200 bg-white text-gray-900 hover:bg-gray-50 flex items-center justify-center rounded-md border py-3 px-3 text-sm font-medium uppercase sm:flex-1"
                  id="headlessui-radiogroup-option-:Ramhr4v5uba:"
                  role="radio"
                  aria-checked="false"
                  data-headlessui-state=""
                  aria-labelledby="headlessui-label-:R1amhr4v5uba:"
                >
                  <span id="headlessui-label-:R1amhr4v5uba:">XS</span>
                </div>
                <div
                  className="cursor-pointer focus:outline-none border-transparent bg-slate-600 text-white hover:bg-slate-700 flex items-center justify-center rounded-md border py-3 px-3 text-sm font-medium uppercase sm:flex-1"
                  id="headlessui-radiogroup-option-:Remhr4v5uba:"
                  role="radio"
                  aria-checked="true"
                  data-headlessui-state="checked"
                  aria-labelledby="headlessui-label-:R1emhr4v5uba:"
                >
                  <span id="headlessui-label-:R1emhr4v5uba:">S</span>
                </div>
                <div
                  className="cursor-pointer focus:outline-none border-gray-200 bg-white text-gray-900 hover:bg-gray-50 flex items-center justify-center rounded-md border py-3 px-3 text-sm font-medium uppercase sm:flex-1"
                  id="headlessui-radiogroup-option-:Rimhr4v5uba:"
                  role="radio"
                  aria-checked="false"
                  data-headlessui-state=""
                  aria-labelledby="headlessui-label-:R1imhr4v5uba:"
                >
                  <span id="headlessui-label-:R1imhr4v5uba:">M</span>
                </div>
                <div
                  className="cursor-pointer focus:outline-none border-gray-200 bg-white text-gray-900 hover:bg-gray-50 flex items-center justify-center rounded-md border py-3 px-3 text-sm font-medium uppercase sm:flex-1"
                  id="headlessui-radiogroup-option-:Rmmhr4v5uba:"
                  role="radio"
                  aria-checked="false"
                  data-headlessui-state=""
                  aria-labelledby="headlessui-label-:R1mmhr4v5uba:"
                >
                  <span id="headlessui-label-:R1mmhr4v5uba:">L</span>
                </div>
                <div
                  className="cursor-not-allowed opacity-25 border-gray-200 bg-white text-gray-900 hover:bg-gray-50 flex items-center justify-center rounded-md border py-3 px-3 text-sm font-medium uppercase sm:flex-1"
                  id="headlessui-radiogroup-option-:Rqmhr4v5uba:"
                  role="radio"
                  aria-checked="false"
                  aria-disabled="true"
                  data-headlessui-state="disabled"
                  aria-labelledby="headlessui-label-:R1qmhr4v5uba:"
                >
                  <span id="headlessui-label-:R1qmhr4v5uba:">XL</span>
                </div>
              </div>
            </div>
          </div>
          <button
            type="submit"
            className="mt-8 flex w-full items-center justify-center rounded-md border border-transparent bg-slate-600 px-8 py-3 text-base font-medium text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
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
