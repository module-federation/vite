# CommonJS SSR replacement memory protocol

The public `strategy: 'cjs'` currently supports Node 24 only. The measured release
is Node 24.19.0, with runtime 2.9.3 and React/react-dom 19.2.4 from the repository
lockfile. Node 22.23.5 failed the declared heap bound; its negative measurements
are retained alongside the supported results rather than averaged away.

Before measuring, the allowance is fixed at **+64 MiB heapUsed above the sample
after the first replacement**, checked independently at 100 and 1,000 replacements.
There are three fresh processes for each trigger (`revalidate('a')` and
`maxAgeMs: 0`). Each measurement follows six synchronous major GCs, each separated
by event-loop turns. There are no heap snapshots, last-resort GCs, compilation-cache
flags, or per-release VM contexts.

Run from the repository root with Node 24:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
node integration/ssr-cjs-memory/build.mjs
node integration/ssr-cjs-memory/build-host.mjs
node integration/ssr-cjs-memory/run.mjs
```

`run.mjs` also accepts an explicit Node executable path. It fails on any protocol
failure. Generated sources, release directories, host output, and JSON/log results
live in the ignored `.mf-cjs-memory/` directory. `MF_CJS_MEMORY_DIR` overrides its
location. Building all releases takes substantial time and disk space; builds run
in batches of 20 fresh producer processes so build-tool caches do not accumulate.

The builder uses this built plugin for a client build followed by an SSR build of
each release. A has 1,001 distinct releases; B has one. Every release has a unique
marker, unique expose path/owner, and manifest `buildVersion`. Its widget captures
a literal of 400,000 distinct numbers and reads it while rendering. The loopback
HTTP server switches the selected, completely built directory atomically; A and B
keep their URLs. The host is itself built with `federation()` and uses public
`createInstance`, `ssrEntryLoader`, and `loadRemote` APIs.

Every load checks the release marker, rendered output, and exact host React
identity. An old component remains held and renderable throughout all replacements.
The explicit-revalidation case asserts that A never fetches B again. Both cases
release the held component and check that its graph's subscription disappears.
Automatic manifest checks can refetch B's manifest during share initialization;
they do not claim the explicit-revalidation no-fetch property.

For a short harness smoke check, set `MF_CJS_MEMORY_COUNT=2` and
`MF_CJS_MEMORY_SIZE=1000` for all four commands. This checks building and loading;
it does not claim the full memory protocol or immediate V8 collection of small
scripts. Full runs always use the defaults, 1,000 replacements and 400,000 numbers.

`measurements.json` records every final supported run and the six pre-guard Node 22
diagnostic runs, including failed checkpoints, External and RSS. The latter used
the public loader before the Node-version guard was added, with the immutable
built-host SHA-256 recorded in the file. The public loader now rejects Node 22
before fetching; reproducing those unsupported measurements requires deliberately
removing that guard in a diagnostic checkout. This is not a supported loader option.

The six supported Windows x64 runs measured these ranges (MiB):

| Trigger | Heap at replacement 1 | Heap at 100 | Heap at 1,000 | Maximum sampled External | Maximum sampled RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| `revalidate('a')` | 21.68–21.69 | 37.47–40.57 | 38.93–38.95 | 41.44 | 149.49 |
| `maxAgeMs: 0` | 22.05 | 37.61 | 39.01 | 33.98 | 149.45 |

All six stayed inside the predeclared allowance at both checkpoints. Five of six
Node 22 diagnostic runs exceeded it. Subscription cleanup alone did not make
Node 22 bounded; these measurements do not establish an exact V8 retaining root.
The summary includes the immutable built-host fingerprint and hashes of the
supported raw result files. Rebuilding the host from the final source reproduced
the same fingerprint. The original lifecycle dependency was commit `988efe5`;
rebasing that dependency does not itself establish a new memory measurement.

The bound describes this replacement workload, not arbitrary application or
external-package allocations. Held application references intentionally keep their
generations alive. Correctness coverage for real nested remote builds, concurrent
loads, evaluation failure and rollback is in `integration/ssr-cjs.test.ts`.
