import React from 'react';

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
            <a href="#" className="flex">
              <span className="sr-only">Your Company</span>
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
            </a>
            <div className="flex flex-1 items-center justify-end">
              <a href="#" className="ml-6 hidden p-2 text-gray-400 hover:text-gray-500 lg:block">
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
              <a href="#" className="p-2 text-gray-400 hover:text-gray-500 lg:ml-4">
                <span className="sr-only">Account</span>
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
                    d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z"
                  ></path>
                </svg>
              </a>
              <div className="ml-4 flow-root lg:ml-6">
                <a href="#" className="group -m-2 flex items-center p-2">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth="1.5"
                    stroke="currentColor"
                    aria-hidden="true"
                    data-slot="icon"
                    className="h-6 w-6 flex-shrink-0 text-gray-400 group-hover:text-gray-500"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 0 0-16.536-1.84M7.5 14.25 5.106 5.272M6 20.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm12.75 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"
                    ></path>
                  </svg>
                  <span className="ml-2 text-sm font-medium text-gray-700 group-hover:text-gray-800">
                    0
                  </span>
                  <span className="sr-only">items in cart, view bag</span>
                </a>
              </div>
            </div>
          </div>
        </div>
      </nav>
    </header>
  );
};
