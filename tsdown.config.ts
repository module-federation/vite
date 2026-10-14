import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/utils/ssrEntryLoader.ts",
    "src/utils/injectExternalRuntimeCorePlugin.ts",
    "src/utils/assetRequestContext.ts",
  ],
  format: ["esm"],
  outDir: "lib",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  dts: true,
  clean: true,
  deps: {
    onlyBundle: false,
    // Remote entries import utils/assetRequestContext.js from the Vite dev server.
    // A bare import there would be found by the dep optimizer only after start-up,
    // which re-optimizes and reloads the page.
    alwaysBundle: ["@module-federation/error-codes"],
  },
});
