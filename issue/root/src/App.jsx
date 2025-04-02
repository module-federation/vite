import { lazy, Suspense } from "react";
import "./App.css";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Landingpage from "./Landing";

const App1 = lazy(() => import("app1/remote-app"));
function App() {
  return (
    <BrowserRouter>
      <h1>React host applicaion</h1>
      <Suspense fallback={<p>loading....</p>}>
        <Routes>
          <Route path="/" element={<Landingpage />} />
          <Route path="/app1/*" element={<App1 />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
