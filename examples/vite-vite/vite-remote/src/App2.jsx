import React from 'react';
import ReactDOM from 'react-dom/client';
import "./app2.sass";

console.log("App2 shared React", React, ReactDOM)
export function App2() {
    return (
        <div className="container">
            Vite react (v. {React.version})App2 as named export via remote with Sass use
        </div>
    );
}
