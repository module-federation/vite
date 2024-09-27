import React from 'react';

export default () => {
  return (
    <section aria-labelledby="reviews-heading" className="mt-16 sm:mt-24">
      <h2 id="reviews-heading" className="text-lg font-medium text-gray-900">
        Recent reviews
      </h2>
      <div className="mt-6 space-y-10 divide-y divide-gray-200 border-b border-t border-gray-200 pb-10">
        <div className="pt-10 lg:grid lg:grid-cols-12 lg:gap-x-8">
          <div className="lg:col-span-8 lg:col-start-5 xl:col-span-9 xl:col-start-4 xl:grid xl:grid-cols-3 xl:items-start xl:gap-x-8">
            <div className="flex items-center xl:col-span-1">
              <div className="flex items-center">
                {[...new Array(5)].map(() => (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                    className="text-yellow-400 h-5 w-5 flex-shrink-0"
                  >
                    <path
                      fill-rule="evenodd"
                      d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z"
                      clip-rule="evenodd"
                    ></path>
                  </svg>
                ))}
              </div>
              <p className="ml-3 text-sm text-gray-700">
                5<span className="sr-only"> out of 5 stars</span>
              </p>
            </div>
            <div className="mt-4 lg:mt-6 xl:col-span-2 xl:mt-0">
              <h3 className="text-sm font-medium text-gray-900">Can't say enough good things</h3>
              <div className="mt-3 space-y-6 text-sm text-gray-500">
                <p>
                  I was really pleased with the overall shopping experience. My order even included
                  a little personal, handwritten note, which delighted me!
                </p>
                <p>
                  The product quality is amazing, it looks and feel even better than I had
                  anticipated. Brilliant stuff! I would gladly recommend this store to my friends.
                  And, now that I think of it... I actually have, many times!
                </p>
              </div>
            </div>
          </div>
          <div className="mt-6 flex items-center text-sm lg:col-span-4 lg:col-start-1 lg:row-start-1 lg:mt-0 lg:flex-col lg:items-start xl:col-span-3">
            <p className="font-medium text-gray-900">Anna Jones</p>
            <span className="ml-4 border-l border-gray-200 pl-4 text-gray-500 lg:ml-0 lg:mt-2 lg:border-0 lg:pl-0">
              May 16, 2024
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};
