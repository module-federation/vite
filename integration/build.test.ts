import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { buildFixture, FIXTURES } from "./helpers/build";
import {
  findAsset,
  findChunk,
  getAllChunkCode,
  getChunkNames,
} from "./helpers/matchers";

const BASIC_REMOTE_MF_OPTIONS = {
  exposes: {
    "./exposed": resolve(FIXTURES, "basic-remote", "exposed-module.js"),
  },
};

describe("build", () => {
  describe("remote", () => {
    it("produces a remoteEntry chunk", async () => {
      const output = await buildFixture({ mfOptions: BASIC_REMOTE_MF_OPTIONS });
      const chunks = getChunkNames(output);
      expect(chunks.some((name) => name.includes("remoteEntry"))).toBe(true);
    });

    it("remoteEntry contains federation runtime init with correct name", async () => {
      const output = await buildFixture({ mfOptions: BASIC_REMOTE_MF_OPTIONS });
      const remoteEntry = findChunk(output, "remoteEntry");
      expect(remoteEntry).toBeDefined();
      expect(remoteEntry!.code).toContain("basicRemote");
      expect(remoteEntry!.code).toContain("localSharedImportMapPromise");
      expect(remoteEntry!.code).toContain("getExposesMap");
    });

    it("exposed module content is included in output", async () => {
      const output = await buildFixture({ mfOptions: BASIC_REMOTE_MF_OPTIONS });
      const allCode = getAllChunkCode(output);
      expect(allCode).toContain("Hello");
    });

    it("generates mf-manifest.json when manifest is enabled", async () => {
      const manifestOutput = await buildFixture({
        mfOptions: { ...BASIC_REMOTE_MF_OPTIONS, manifest: true },
      });

      const manifest = findAsset(manifestOutput, "mf-manifest.json");
      expect(manifest).toBeDefined();

      const parsed = JSON.parse(manifest!.source as string);
      expect(parsed).toHaveProperty("exposes");
    });

    it("generates mf-stats.json when manifest is enabled", async () => {
      const manifestOutput = await buildFixture({
        mfOptions: { ...BASIC_REMOTE_MF_OPTIONS, manifest: true },
      });

      const stats = findAsset(manifestOutput, "mf-stats.json");
      expect(stats).toBeDefined();

      const parsed = JSON.parse(stats!.source as string);
      expect(parsed).toHaveProperty("buildOutput");
      expect(parsed).toHaveProperty("metaData");
    });

    it("respects manifest fileName for companion stats filename", async () => {
      const manifestOutput = await buildFixture({
        mfOptions: {
          ...BASIC_REMOTE_MF_OPTIONS,
          manifest: {
            fileName: "custom-manifest.json",
          },
        },
      });

      const manifest = findAsset(manifestOutput, "custom-manifest.json");
      const stats = findAsset(manifestOutput, "custom-manifest-stats.json");
      expect(manifest).toBeDefined();
      expect(stats).toBeDefined();
    });

    it("does not include shared/exposes in manifest when disableAssetsAnalyze is true", async () => {
      const manifestOutput = await buildFixture({
        mfOptions: {
          ...BASIC_REMOTE_MF_OPTIONS,
          manifest: {
            fileName: "disabled-manifest.json",
            disableAssetsAnalyze: true,
          },
          shared: {
            react: { import: false },
          },
        },
      });

      const manifest = findAsset(manifestOutput, "disabled-manifest.json");
      expect(manifest).toBeDefined();

      const parsed = JSON.parse(manifest!.source as string);
      expect(parsed).not.toHaveProperty("exposes");
      expect(parsed).not.toHaveProperty("shared");
    });
  });
});
