# CommonJS SSR replacement memory protocol

The public `strategy: 'cjs'` supports Node 24 only, validated on 24.19.0 with
runtime 2.9.3 and React/react-dom 19.2.4 from the repository lockfile. After
isolating HTTP transport from remote graph context, all 15 fresh Node 24
replacement, instrumentation and cached-load control processes passed the
documented protocol. Node 22.23.5 still failed the bound in fresh post-fix runs;
the public version guard remains unchanged. Pre-fix counterevidence is retained.

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
node integration/ssr-cjs-memory/run.mjs --metadata
```

`run.mjs` also accepts an explicit Node executable path. Its default runs three
fresh workers per trigger plus three cached-load controls; `--metadata` runs six
separately identified replacement workers with the added in-process hashing and
metadata described below. Each group uses three parallel workers. Both modes
fail on any protocol failure and retain every status. Generated sources, release
directories, host output, and JSON/log results
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

`measurements.json` preserves six pre-isolation original-protocol runs and the six pre-guard Node 22
diagnostic runs, including failed checkpoints, External and RSS. The latter used
the public loader before the Node-version guard was added, with the immutable
built-host SHA-256 recorded in the file. The public loader now rejects Node 22
before fetching; reproducing those unsupported measurements requires deliberately
removing that guard in a diagnostic checkout. This is not a supported loader option.

The six pre-isolation original-protocol Windows x64 runs measured these ranges (MiB):

| Trigger           | Heap at replacement 1 | Heap at 100 | Heap at 1,000 | Maximum sampled External | Maximum sampled RSS |
| ----------------- | --------------------: | ----------: | ------------: | -----------------------: | ------------------: |
| `revalidate('a')` |                 21.68 | 37.48–37.49 |         38.93 |                    37.71 |              148.42 |
| `maxAgeMs: 0`     |                 22.05 |       37.62 |   39.00–39.01 |                    33.98 |              148.99 |

All six stayed inside the predeclared allowance at both checkpoints. Five of six
Node 22 diagnostic runs exceeded it. Subscription cleanup alone did not make
Node 22 bounded; these measurements do not establish an exact V8 retaining root.
The summary includes the immutable built-host fingerprint and hashes of the raw
result files. These six runs used the final lifecycle dependency `21ab90e`,
after rebasing the feature onto current main. Provenance was computed in a
separate process so it did not change the measured worker's imports or heap.

Additional controls used that same final host, releases, +64 MiB allowance,
ordinary GC protocol and three parallel fresh workers per case:

| Worker variation                     | Trigger                                   | Passed | Counterevidence                                                                              |
| ------------------------------------ | ----------------------------------------- | -----: | -------------------------------------------------------------------------------------------- |
| Original worker                      | Both, three runs each                     |    6/6 | None in this case                                                                            |
| Only an added `node:crypto` import   | Targeted revalidation                     |    3/3 | None in this case                                                                            |
| Added host-file hashing and metadata | Targeted revalidation, no unit/build jobs |    2/3 | One final listener count was 3 rather than 2                                                 |
| Added host-file hashing and metadata | Both, while unit/typecheck jobs also ran  |    3/6 | One heap was 94.53 MiB versus 21.74 + 64 MiB; two final listener counts were 3 rather than 2 |

The extra metadata worker imported `createHash` from `node:crypto`, read and
hashed the built host before loading it, then included its fingerprint, platform,
Vite and React versions in the result. The import-only control did not reproduce
the failures. The quiet metadata control reproduced a cleanup timing miss, so
concurrent test load alone does not explain all observed failures. These controls
do not establish an exact V8 retaining root or prove that hashing caused the heap
failure. Passing the original protocol is insufficient to claim a general bounded
memory guarantee. The negative JSON samples and log/result hashes are retained in
the `diagnostics` section of `measurements.json`; cleanup failures are identified
as stdout-derived because their assertion occurred before the original JSON write.

The bound describes this replacement workload, not arbitrary application or
external-package allocations. Held application references intentionally keep their
generations alive. Correctness coverage for real nested remote builds, concurrent
loads, evaluation failure and rollback is in `integration/ssr-cjs.test.ts`.

## HTTP transport isolation and post-fix measurements

The earlier measurements above predate transport isolation. Native fetch can
create a process-owned Undici parser timer under the caller's AsyncLocalStorage
store. A minimal real-fetch witness on Node 22 and 24 retained a completed
request's store through an `onParserTimeout` timer after six ordinary GCs; an
equivalent request created through `AsyncLocalStorage.exit()` collected. The
timer and store collected after a separate diagnostic 3.4-second wait and six
additional GCs. The library now creates fetch and consumes the complete body
inside `withoutSsrBuildGraph()`, then evaluates the source under the remote graph.
Deterministic regression tests check the context boundary, body limit and real
evaluation/init/get/factory context.

Reproduce that small transport witness independently of the plugin:

```sh
node --expose-gc integration/ssr-cjs-memory/transport-als-diagnostic.mjs
```

The observer retains only WeakRefs and primitive metadata, and begins each GC
after an event-loop turn. Timeout details are diagnostic Node internals, not a
library dependency. Exact observed outputs are summarized in
`transport-als-evidence.json`. Its extra wait/GC phase never changes the declared
benchmark checkpoints or reclassifies a failed measurement.

`transport-isolation-results.json` records a freshly federation-built host from
source `838b045`, fingerprint `d8908694…f4d49dc`, using the same 1,001 built A
releases and unchanged B. The original and metadata cases each used three fresh
processes per replacement trigger; no other local tests or builds ran alongside.
Every original heap checkpoint stayed inside the unchanged +64 MiB allowance.

| Post-isolation case                | Passed | Maximum checkpoint heap increase | Maximum sampled External | Maximum sampled RSS |
| ---------------------------------- | -----: | -------------------------------: | -----------------------: | ------------------: |
| Original replacement protocol      |    6/6 |                        17.25 MiB |                37.71 MiB |          149.64 MiB |
| Added hashing and metadata         |    6/6 |                        17.25 MiB |                45.22 MiB |          149.87 MiB |
| No replacement, 1,000 cached loads |    3/3 |                         0.78 MiB |                11.62 MiB |           92.55 MiB |

All 15 also preserved exact host React identity, held old rendering, eventual
old graph subscription release (two current subscribers), and zero global init
entries. Targeted revalidation and cached-load controls did not fetch B again.

The separate post-fix Node 22 diagnostic disabled the public version guard only
in a fingerprinted scratch host. One initial 100-replacement probe passed, but
three fresh targeted runs exceeded the bound at 100: heap 366.82–407.75 MiB
against roughly 32.4 MiB after replacement 1. Those workers were stopped after
that failed checkpoint; no 1,000-replacement result is claimed for them. Both
the passing probe and all three failures are retained. Node 22 remains unsupported.

These results establish the documented Node 24 replacement protocol after the
fix. They do not identify the exact retaining root of the earlier 94.53 MiB
measurement or establish a memory limit for arbitrary application allocations.
The earlier failures in `measurements.json` remain evidence, rather than being
replaced by the post-fix results.
