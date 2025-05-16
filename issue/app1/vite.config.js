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
      name: "app1",
      filename: "remoteEntry.js",
      remotes: {
        host: {
          name: "host",
          type: "module",
          entry: `${hostname}/remoteEntry.js`,
          entryGlobalName: "host",
          shareScope: "default",
        },
      },
      exposes: {
        "./remote-app": "./src/App.jsx",
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
  base: "/app1",
  build: {
    target: "es2022",
    outDir: "build",
  },
});
