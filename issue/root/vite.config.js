import { federation } from "@module-federation/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

let hostname = "";
if (typeof window !== undefined) {
  hostname = window.location.origin;
}
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: "host",
      filename: "remoteEntry.js",
      remotes: {
        app1: {
          name: "app1",
          type: "module",
          entry: `${hostname}/app1/remoteEntry.js`,
          entryGlobalName: "app1",
          shareScope: "default",
        },
      },
      exposes: {
        "./App": "./src/App.jsx",
      },
      shared: {
        react: {
          singleton: true,
        },
        "react/": {
          singleton: true,
        },
      },
    }),
  ],
  build: {
    target: "es2022",
    outDir: "build",
  },
  server: {
    port: 3000,
  },
});
