export default () => {
  return (
    <section aria-labelledby="purchases-count" className="mt-16 sm:mt-24">
      <h2 className="text-lg font-medium text-gray-900">Count of purchases </h2>

      <div className="mt-6">
        <h3 className="text-sm font-medium text-gray-900">Total</h3>
        <div className="mt-3 space-y-6 text-sm text-gray-500">1928</div>
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-medium text-gray-900">For the last 30 days</h3>
        <div className="mt-3 space-y-6 text-sm text-gray-500">155</div>
      </div>
    </section>
  );
};
