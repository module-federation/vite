import React from 'react';
import AccountIcon from './AccountIcon';
import BagIcon from './BagIcon';
import CartIcon from './CartIcon';
import SearchIcon from './SearchIcon';

export const Header: React.FC = () => {
  return (
    <header className="relative bg-white">
      <nav aria-label="Top" className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="border-b border-gray-200">
          <div className="flex h-16 items-center justify-between">
            <div className="flex flex-1 items-center lg:hidden">
              <button type="button" className="-ml-2 rounded-md bg-white p-2 text-gray-400">
                <span className="sr-only">Open menu</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth="1.5"
                  stroke="currentColor"
                  aria-hidden="true"
                  data-slot="icon"
                  className="h-6 w-6"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                  ></path>
                </svg>
              </button>
              <a href="#" className="ml-2 p-2 text-gray-400 hover:text-gray-500">
                <span className="sr-only">Search</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth="1.5"
                  stroke="currentColor"
                  aria-hidden="true"
                  data-slot="icon"
                  className="h-6 w-6"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
                  ></path>
                </svg>
              </a>
            </div>
            <div className="hidden lg:block lg:flex-1 lg:self-stretch">
              <div className="flex h-full space-x-8">
                <div className="flex">
                  <div className="relative flex">
                    <button
                      className="text-gray-700 hover:text-gray-800 relative z-10 flex items-center justify-center text-sm font-medium transition-colors duration-200 ease-out"
                      type="button"
                      aria-expanded="false"
                    >
                      Women
                      <span
                        className="absolute inset-x-0 bottom-0 h-0.5 transition-colors duration-200 ease-out sm:mt-5 sm:translate-y-px sm:transform"
                        aria-hidden="true"
                      ></span>
                    </button>
                  </div>
                </div>
                <div className="flex">
                  <div className="relative flex">
                    <button
                      className="text-gray-700 hover:text-gray-800 relative z-10 flex items-center justify-center text-sm font-medium transition-colors duration-200 ease-out"
                      type="button"
                      aria-expanded="false"
                    >
                      Men
                      <span
                        className="absolute inset-x-0 bottom-0 h-0.5 transition-colors duration-200 ease-out sm:mt-5 sm:translate-y-px sm:transform"
                        aria-hidden="true"
                      ></span>
                    </button>
                  </div>
                </div>
                <div className="flex">
                  <div className="relative flex">
                    <button
                      className="text-gray-700 hover:text-gray-800 relative z-10 flex items-center justify-center text-sm font-medium transition-colors duration-200 ease-out"
                      type="button"
                      aria-expanded="false"
                    >
                      Company
                      <span
                        className="absolute inset-x-0 bottom-0 h-0.5 transition-colors duration-200 ease-out sm:mt-5 sm:translate-y-px sm:transform"
                        aria-hidden="true"
                      ></span>
                    </button>
                  </div>
                </div>
                <div className="flex">
                  <div className="relative flex">
                    <button
                      className="text-gray-700 hover:text-gray-800 relative z-10 flex items-center justify-center text-sm font-medium transition-colors duration-200 ease-out"
                      type="button"
                      aria-expanded="false"
                    >
                      Stores
                      <span
                        className="absolute inset-x-0 bottom-0 h-0.5 transition-colors duration-200 ease-out sm:mt-5 sm:translate-y-px sm:transform"
                        aria-hidden="true"
                      ></span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div
              style={{
                position: 'fixed',
                top: '1px',
                left: '1px',
                width: '1px',
                height: 0,
                padding: 0,
                margin: '-1px',
                overflow: 'hidden',
                clip: 'rect(0, 0, 0, 0)',
                whiteSpace: 'nowrap',
                borderWidth: '0',
                display: 'none',
              }}
            ></div>
            <BagIcon />
            <div className="flex flex-1 items-center justify-end">
              <SearchIcon />
              <AccountIcon />
              <CartIcon />
            </div>
          </div>
        </div>
      </nav>
    </header>
  );
};
