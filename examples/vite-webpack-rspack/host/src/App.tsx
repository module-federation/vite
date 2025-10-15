import { registerRemotes } from '@module-federation/runtime';
import React, { lazy, StrictMode, Suspense, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { Toggle } from './components/Toggle';
import { useDynamicImport } from './hooks/useDynamicImport';
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
const TestsScreen = lazy(
  () =>
    // @ts-ignore
    import('testsRemote/TestsScreen')
);

// if module federation is already setup through plugin in vite.config.js,
// there is no need to call init() from '@module-federation/runtime' here
registerRemotes([
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
            <RemoteProduct />
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
