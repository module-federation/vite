import React from 'react';

const year = new Date().getFullYear();

export const Footer: React.FC = () => {
  return (
    <footer aria-labelledby="footer-heading">
      <h2 id="footer-heading" className="sr-only">
        Footer
      </h2>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="border-t border-gray-200 py-20">
          <div className="grid grid-cols-1 md:grid-flow-col md:auto-rows-min md:grid-cols-12 md:gap-x-8 md:gap-y-16">
            <div className="col-span-1 md:col-span-2 lg:col-start-1 lg:row-start-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="1.5"
                stroke="currentColor"
                aria-hidden="true"
                data-slot="icon"
                className="h-8 w-auto"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 10.5V6a3.75 3.75 0 1 0-7.5 0v4.5m11.356-1.993 1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 0 1-1.12-1.243l1.264-12A1.125 1.125 0 0 1 5.513 7.5h12.974c.576 0 1.059.435 1.119 1.007ZM8.625 10.5a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm7.5 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"
                ></path>
              </svg>
            </div>
            <div className="col-span-6 mt-10 grid grid-cols-2 gap-8 sm:grid-cols-3 md:col-span-8 md:col-start-3 md:row-start-1 md:mt-0 lg:col-span-6 lg:col-start-2">
              <div className="grid grid-cols-1 gap-y-12 sm:col-span-2 sm:grid-cols-2 sm:gap-x-8">
                <div>
                  <h3 className="text-sm font-medium text-gray-900">Products</h3>
                  <ul role="list" className="mt-6 space-y-6">
                    <li className="text-sm">
                      <a href="#" className="text-gray-500 hover:text-gray-600">
                        Bags
                      </a>
                    </li>
                    <li className="text-sm">
                      <a href="#" className="text-gray-500 hover:text-gray-600">
                        Tees
                      </a>
                    </li>
                    <li className="text-sm">
                      <a href="#" className="text-gray-500 hover:text-gray-600">
                        Objects
                      </a>
                    </li>
                    <li className="text-sm">
                      <a href="#" className="text-gray-500 hover:text-gray-600">
                        Home Goods
                      </a>
                    </li>
                    <li className="text-sm">
                      <a href="#" className="text-gray-500 hover:text-gray-600">
                        Accessories
                      </a>
                    </li>
                  </ul>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-gray-900">Company</h3>
                  <ul role="list" className="mt-6 space-y-6">
                    <li className="text-sm">
                      <a href="#" className="text-gray-500 hover:text-gray-600">
                        Who we are
                      </a>
                    </li>
                    <li className="text-sm">
                      <a href="#" className="text-gray-500 hover:text-gray-600">
                        Sustainability
                      </a>
                    </li>
                    <li className="text-sm">
                      <a href="#" className="text-gray-500 hover:text-gray-600">
                        Press
                      </a>
                    </li>
                    <li className="text-sm">
                      <a href="#" className="text-gray-500 hover:text-gray-600">
                        Careers
                      </a>
                    </li>
                    <li className="text-sm">
                      <a href="#" className="text-gray-500 hover:text-gray-600">
                        Terms &amp; Conditions
                      </a>
                    </li>
                    <li className="text-sm">
                      <a href="#" className="text-gray-500 hover:text-gray-600">
                        Privacy
                      </a>
                    </li>
                  </ul>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-medium text-gray-900">Customer Service</h3>
                <ul role="list" className="mt-6 space-y-6">
                  <li className="text-sm">
                    <a href="#" className="text-gray-500 hover:text-gray-600">
                      Contact
                    </a>
                  </li>
                  <li className="text-sm">
                    <a href="#" className="text-gray-500 hover:text-gray-600">
                      Shipping
                    </a>
                  </li>
                  <li className="text-sm">
                    <a href="#" className="text-gray-500 hover:text-gray-600">
                      Returns
                    </a>
                  </li>
                  <li className="text-sm">
                    <a href="#" className="text-gray-500 hover:text-gray-600">
                      Warranty
                    </a>
                  </li>
                  <li className="text-sm">
                    <a href="#" className="text-gray-500 hover:text-gray-600">
                      Secure Payments
                    </a>
                  </li>
                  <li className="text-sm">
                    <a href="#" className="text-gray-500 hover:text-gray-600">
                      FAQ
                    </a>
                  </li>
                  <li className="text-sm">
                    <a href="#" className="text-gray-500 hover:text-gray-600">
                      Find a store
                    </a>
                  </li>
                </ul>
              </div>
            </div>
            <div className="mt-12 md:col-span-8 md:col-start-3 md:row-start-2 md:mt-0 lg:col-span-4 lg:col-start-9 lg:row-start-1">
              <h3 className="text-sm font-medium text-gray-900">Sign up for our newsletter</h3>
              <p className="mt-6 text-sm text-gray-500">
                The latest deals and savings, sent to your inbox weekly.
              </p>
              <form className="mt-2 flex sm:max-w-md">
                <label className="sr-only">Email address</label>
                <input
                  id="email-address"
                  type="text"
                  auto-complete="email"
                  className="w-full min-w-0 appearance-none rounded-md border border-gray-300 bg-white px-4 py-2 text-base text-gray-900 placeholder-gray-500 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                />
                <div className="ml-4 flex-shrink-0">
                  <button
                    type="submit"
                    className="flex w-full items-center justify-center rounded-md border border-transparent bg-slate-600 px-4 py-2 text-base font-medium text-white shadow-sm hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
                  >
                    Sign up
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
        <div className="border-t border-gray-100 py-10 text-center">
          <p className="text-sm text-gray-500">© {year} Your Company, Inc. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
};
