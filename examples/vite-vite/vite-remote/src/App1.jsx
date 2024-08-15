import React from 'react';
import vueImg from "./assets/vue.svg";

export default function () {
  return (
    <div style={{ background: 'yellow', padding: 30 }}>
      <img src={vueImg} />
      Vite React App1 as default export via remote in
      <i>{import.meta.env.DEV ? ' Dev ' : ' prod '}</i> mode
    </div>
  );
}
