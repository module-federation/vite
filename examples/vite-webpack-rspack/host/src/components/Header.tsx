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
            <div className="hidden lg:block lg:flex-1 lg:self-stretch">
              <div className="flex h-full space-x-8">
                {['Women', 'Man', 'Company', 'Stores'].map((s, i) => (
                  <div className="flex">
                    <div className="relative flex">
                      <button
                        className="text-gray-700 hover:text-gray-800 relative z-10 flex items-center justify-center text-sm font-medium transition-colors duration-200 ease-out"
                        type="button"
                        aria-expanded="false"
                      >
                        {s}
                        <span
                          className="absolute inset-x-0 bottom-0 h-0.5 transition-colors duration-200 ease-out sm:mt-5 sm:translate-y-px sm:transform"
                          aria-hidden="true"
                        ></span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
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
