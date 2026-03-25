import { SharedCounter, formatLabel } from "@vite-vite/shared-lib";
import R from "react";
import RD from "react-dom/client";

import App from "@namespace/viteViteRemote";
import AgGridDemo from "@namespace/viteViteRemote/AgGridDemo";
import App1 from "@namespace/viteViteRemote/App1";
import App2 from "@namespace/viteViteRemote/App2";
import EmotionDemo from "@namespace/viteViteRemote/EmotionDemo";
import MuiDemo from "@namespace/viteViteRemote/MuiDemo";
import StyledDemo from "@namespace/viteViteRemote/StyledDemo";

console.log("Share React", R, RD);

export default function HostApp() {
  return (
    <div style={{ background: "lightgray" }}>
      <p>
        Vite React (v {R.version}) app running from Host in{" "}
        <i> {import.meta.env.DEV ? " Dev " : " prod "} mode </i>
      </p>
      <h2>Shared Library</h2>
      <SharedCounter label={formatLabel("Host")} />

      <hr />

      <h2>Vite Remote Default App</h2>
      <App />

      <h2>Vite Remote App1</h2>
      <App1 />

      <h2>Vite Remote App2</h2>
      <App2 />

      <h2>Emotion Styled Components Demo</h2>
      <EmotionDemo />

      <h2>Vite Remote MuiDemo</h2>
      <MuiDemo />

      <h2>Styled Components Demo</h2>
      <StyledDemo />

      <h2>Vite Remote AgGridDemo</h2>
      <AgGridDemo />

      <hr />
    </div>
  );
}
