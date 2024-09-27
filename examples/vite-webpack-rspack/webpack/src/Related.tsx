import React from 'react';

export default () => {
  return (
    <section aria-labelledby="related-heading" className="mt-16 sm:mt-24">
      <h2 id="related-heading" className="text-lg font-medium text-gray-900">
        Customers also purchased
      </h2>
      <div className="mt-6 grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-4 xl:gap-x-8 text-left">
        <div className="group relative">
          <div className="aspect-h-1 aspect-w-1 w-full overflow-hidden rounded-md lg:aspect-none group-hover:opacity-75 lg:h-80">
            <img
              alt="Front of men's Basic Tee in white."
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover object-center lg:h-full lg:w-full"
              style={{ color: 'transparent' }}
              src="http://localhost:8080/product1.webp"
            />
          </div>
          <div className="mt-4 flex justify-between">
            <div>
              <h3 className="text-sm text-gray-700">
                <a href="#">
                  <span aria-hidden="true" className="absolute inset-0"></span>Basic Tee
                </a>
              </h3>
              <p className="mt-1 text-sm text-gray-500">Aspen White</p>
            </div>
            <p className="text-sm font-medium text-gray-900">35 €</p>
          </div>
        </div>
      </div>
    </section>
  );
};
