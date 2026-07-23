import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/utils/ssrEntryLoader.ts",
    "src/utils/injectExternalRuntimeCorePlugin.ts",
  ],
  format: ["esm"],
  outDir: "lib",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  dts: true,
  clean: true,
  deps: {
    onlyAllowBundle: false,
  },
});
