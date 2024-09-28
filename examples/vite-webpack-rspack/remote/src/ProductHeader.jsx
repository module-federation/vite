export default () => (
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
          {[...new Array(5)].map((_, i) => (
            <svg
              key={i}
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
              className={`${i === 4 ? 'text-gray-200' : 'text-yellow-400'} h-5 w-5 flex-shrink-0`}
            >
              <path
                fillRule="evenodd"
                d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z"
                clipRule="evenodd"
              ></path>
            </svg>
          ))}
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
);
