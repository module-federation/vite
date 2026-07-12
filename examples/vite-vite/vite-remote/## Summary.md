## Summary

Align shared dependency tree-shaking behavior with the Rspack specification.

## Changes
- Removed the unsupported per-shared treeShaking.filename option.
- Use treeShakingDir to control generated tree-shaking artifact paths.
- Added validation to prevent using eager: true together with treeShaking.
- Preserved support for:
    - runtime-infer
    - server-calc
    - usedExports
    - eager shared dependencies
- Updated generated manifests and runtime metadata to match the supported configuration.
- Added documentation covering tree-shaking modes, eager incompatibility, deployment requirements for
  server-calc, and fallback behavior.

## Verification
- Tested all lazy, eager, runtime-infer, and server-calc configurations in development and previewmode.
- Verified host and remote rendering through DOM inspection, browser console checks, and screenshots.
- Inspected generated JavaScript artifacts, file paths, sizes, manifests, and stats files.
- Confirmed tree-shaken providers and metadata are generated only for tree-shaking configurations.
- Confirmed eager configurations include shared dependencies in the initial bundle without generatingtree-
  shaking providers.
- pnpm typecheck passes.
- Focused test suite passes: 248 tests.