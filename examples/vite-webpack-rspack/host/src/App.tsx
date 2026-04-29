import React, { lazy, StrictMode, Suspense, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { Toggle } from './components/Toggle';
import { useDynamicImport } from './hooks/useDynamicImport';
import './index.css';
import { mfRuntime } from './mfRuntime';

import _ from 'lodash';
_.VERSION;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lazyWithRetry<T extends { default: React.ComponentType<any> }>(
  importer: () => Promise<T>,
  retries = 20,
  delayMs = 500
) {
  return lazy(async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await importer();
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await sleep(delayMs);
        }
      }
    }
    throw lastError;
  });
}

const ModuleRemoteProduct = lazyWithRetry(
  () =>
    // @ts-ignore
    import('moduleRemote/Product')
);

const VarRemotePurchasesCount = lazyWithRetry(
  () =>
    // @ts-ignore
    import('remote/PurchasesCount')
);

const RspackReviews = lazyWithRetry(
  () =>
    // @ts-ignore
    import('rspack/Reviews')
);

const WebpackRelated = lazyWithRetry(
  () =>
    // @ts-ignore
    import('webpack/Related')
);

const TestsScreen = lazyWithRetry(
  () =>
    // @ts-ignore
    import('testsRemote/TestsScreen')
);

mfRuntime.registerRemotes([
  {
    name: 'dynamicRemote',
    entry: 'http://localhost:4002/remoteEntry.js',
    type: 'module',
  },
]);

const App = () => {
  const [showTestPage, setShowTestPage] = React.useState(false);
  const [showAd, setShowAd] = React.useState(false);
  const [randomBanner, setRandomBanner] = React.useState<'SignUpBanner' | 'SpecialPromo'>(
    'SpecialPromo'
  );

  const Banner = useDynamicImport({
    module: randomBanner,
    scope: 'dynamicRemote',
  });

  useEffect(() => {
    // alternate between SignUpBanner and SpecialPromo on toggle
    if (!showAd) {
      setRandomBanner((prev) => (prev === 'SignUpBanner' ? 'SpecialPromo' : 'SignUpBanner'));
    }
  }, [showAd]);

  return (
    <div className="bg-white">
      <Header onTestsChange={setShowTestPage} />
      {!showTestPage ? (
        <main className="mx-auto mt-8 max-w-2xl px-4 pb-16 sm:px-6 sm:pb-24 lg:max-w-7xl lg:px-8">
          <Toggle label="Show Dynamic Ad" checked={showAd} onValueChange={setShowAd} />
          {showAd && <Suspense fallback="Loading...">{Banner ? <Banner /> : null}</Suspense>}
          <Suspense fallback="Loading...">
            <ModuleRemoteProduct />
          </Suspense>
          <Suspense fallback="Loading...">
            <VarRemotePurchasesCount />
          </Suspense>
          <Suspense fallback="Loading...">
            <RspackReviews />
          </Suspense>
          <Suspense fallback="Loading...">
            <WebpackRelated />
          </Suspense>
        </main>
      ) : (
        <main className="mx-auto mt-8 max-w-2xl px-4 pb-16 sm:px-6 sm:pb-24 lg:max-w-7xl lg:px-8">
          <Suspense fallback="Loading...">
            <TestsScreen />
          </Suspense>
        </main>
      )}
      <Footer />
    </div>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
