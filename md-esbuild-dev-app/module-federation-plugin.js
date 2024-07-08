import { withFederation } from '@module-federation/esbuild/build';
import { moduleFederationPlugin } from '@module-federation/esbuild/plugin';
import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

export const federation = (federationConfig) => {
  return {
    name: 'module-federation-plugin',
    enforce: 'post',
    async generateBundle() {
      const exposes = federationConfig.exposes ?? {};
      Object.keys(federationConfig.exposes ?? {}).forEach(async (expose) => {
        try {
          const fileName = expose.split('/')[1];
          const moduleData = this.getModuleInfo(exposes[expose]);
          const cacheDir = path.join('.module_federation_temp');
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(`${cacheDir}/${fileName}.js`, moduleData.code);
          federationConfig.exposes[expose] = `./${cacheDir}/${fileName}.js`;
        } catch (error) {
          console.log(error);
        }
      });
      await buildModuleFederation(federationConfig);
    },
    // async renderChunk(code, info) {
    //   Object.entries(federationConfig.exposes ?? {}).forEach(async ([key, expose]) => {
    //     try {
    //       if (expose === info.facadeModuleId) {
    //         const fileName = key.split('/')[1];
    //         const cacheDir = path.join('module_federation_temp');
    //         fs.mkdirSync(cacheDir, { recursive: true });
    //         fs.writeFileSync(`${cacheDir}/${fileName}.js`, code);
    //         console.log(code);
    //         federationConfig.exposes[key] = `./${cacheDir}/${fileName}.js`;
    //       }
    //     } catch (error) {
    //       console.log(error);
    //     }
    //   });
    //   await buildModuleFederation(federationConfig);
    // },
  };
};

async function buildModuleFederation(federationConfig) {
  try {
    await esbuild.build({
      outdir: 'dist',
      bundle: true,
      platform: 'neutral',
      format: 'esm',
      mainFields: ['es2020', 'browser', 'module', 'main'],
      conditions: ['es2020', 'es2015', 'module'],
      splitting: true,
      plugins: [moduleFederationPlugin(withFederation(federationConfig))],
      // Avoid vue to be parsed by ESBuild
      external: ['vue', '\x00plugin-vue:export-helper'],
    });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
