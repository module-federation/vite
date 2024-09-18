
// Windows temporarily needs this file, https://github.com/module-federation/vite/issues/68

    const importMap = {
      
        "react": async () => {
          let pkg = await import("__mf__virtual/viteRemote__prebuild__react__prebuild__.js")
          return pkg
        }
      ,
        "react-dom": async () => {
          let pkg = await import("__mf__virtual/viteRemote__prebuild__react_mf_2_dom__prebuild__.js")
          return pkg
        }
      ,
        "vue": async () => {
          let pkg = await import("__mf__virtual/viteRemote__prebuild__vue__prebuild__.js")
          return pkg
        }
      
    }
      const usedShared = {
      
          "react": {
            name: "react",
            version: "18.3.1",
            scope: ["default"],
            loaded: false,
            from: "viteRemote",
            async get () {
              usedShared["react"].loaded = true
              const {"react": pkgDynamicImport} = importMap 
              const res = await pkgDynamicImport()
              const exportModule = {...res}
              // All npm packages pre-built by vite will be converted to esm
              Object.defineProperty(exportModule, "__esModule", {
                value: true,
                enumerable: false
              })
              return function () {
                return exportModule
              }
            },
            shareConfig: {
              singleton: false,
              requiredVersion: "18"
            }
          }
        ,
          "react-dom": {
            name: "react-dom",
            version: "18.3.1",
            scope: ["default"],
            loaded: false,
            from: "viteRemote",
            async get () {
              usedShared["react-dom"].loaded = true
              const {"react-dom": pkgDynamicImport} = importMap 
              const res = await pkgDynamicImport()
              const exportModule = {...res}
              // All npm packages pre-built by vite will be converted to esm
              Object.defineProperty(exportModule, "__esModule", {
                value: true,
                enumerable: false
              })
              return function () {
                return exportModule
              }
            },
            shareConfig: {
              singleton: false,
              requiredVersion: "^18.3.1"
            }
          }
        ,
          "vue": {
            name: "vue",
            version: "3.5.3",
            scope: ["default"],
            loaded: false,
            from: "viteRemote",
            async get () {
              usedShared["vue"].loaded = true
              const {"vue": pkgDynamicImport} = importMap 
              const res = await pkgDynamicImport()
              const exportModule = {...res}
              // All npm packages pre-built by vite will be converted to esm
              Object.defineProperty(exportModule, "__esModule", {
                value: true,
                enumerable: false
              })
              return function () {
                return exportModule
              }
            },
            shareConfig: {
              singleton: false,
              requiredVersion: "^3.5.3"
            }
          }
        
    }
      const usedRemotes = [
                {
                  entryGlobalName: "mfapp01",
                  name: "mfapp01",
                  type: "var",
                  entry: "https://unpkg.com/mf-app-01@1.0.11/dist/remoteEntry.js",
                }
          ,
                {
                  entryGlobalName: "mfapp02",
                  name: "remote2",
                  type: "var",
                  entry: "https://unpkg.com/mf-app-02/dist/remoteEntry.js",
                }
          ,
                {
                  entryGlobalName: "remote1",
                  name: "remote3",
                  type: "var",
                  entry: "https://unpkg.com/react-manifest-example_remote1@1.0.6/dist/mf-manifest.json",
                }
          
      ]
      export {
        usedShared,
        usedRemotes
      }
      