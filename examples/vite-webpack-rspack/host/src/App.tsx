import React, { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import './index.css';

const RemoteProduct = lazy(
  () =>
    // @ts-ignore
    import('remote/Product')
);
const RspackReviews = lazy(
  () =>
    // @ts-ignore
    import('rspack/Reviews')
);
const WebpackRelated = lazy(
  () =>
    // @ts-ignore
    import('webpack/Related')
);

const App = () => {
  return (
    <div className="bg-white">
      <Header />
      <main className="mx-auto mt-8 max-w-2xl px-4 pb-16 sm:px-6 sm:pb-24 lg:max-w-7xl lg:px-8">
        <Suspense fallback="Loading...">
          <RemoteProduct />
        </Suspense>
        <Suspense fallback="Loading...">
          <RspackReviews />
        </Suspense>
        <Suspense fallback="Loading...">
          <WebpackRelated />
        </Suspense>
      </main>
      <Footer />
    </div>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
