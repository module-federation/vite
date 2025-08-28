import "./App.css";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Homepage from "./homepage";
import Contacts from "./contacts";
import { Suspense } from "react";
import Landingpage from "./Landing";

function App() {
  return (
    <>
      <BrowserRouter>
        <h4>applicaion 1</h4>
        <Suspense fallback={<p>loading....</p>}>
          <Routes>
            <Route exact path="/app1">
              <Route index element={<Landingpage />} />
              <Route path="home" element={<Homepage />} />
              <Route path="contacts" element={<Contacts />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </>
  );
}

export default App;
