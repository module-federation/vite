# Expose queue benchmark

This benchmark reproduces the large-remote waterfall from issue #1041 with a
real Vite build, a local HTTP server, and a headless Chromium page. It creates
21 expose modules at runtime, each containing approximately 1.5 MB of module
content, so the repository does not need to store a large generated fixture.

The benchmark is opt-in and is not part of the default test suite because
browser startup and absolute network timings are environment-dependent.

## Run

```sh
pnpm benchmark:expose-queue
```

The command prints the following values:

- `maxInFlight`: the largest number of expose chunks being transferred at once.
- `startSpanMs`: the interval between the first and last expose request start.
- `totalMs`: elapsed time from loading the remote entry until every expose is loaded.
- `measuredBytes`: bytes reported by the browser for the expose chunks.

`maxInFlight` and `startSpanMs` are measured from the local HTTP server's
request lifecycle, so browser connection queuing is visible separately from
the JavaScript expose scheduler.

The default workload can be adjusted for local experiments:

```sh
EXPOSE_QUEUE_BENCHMARK_EXPOSES=21 \
EXPOSE_QUEUE_BENCHMARK_BYTES=1500000 \
EXPOSE_QUEUE_BENCHMARK_DELAY_MS=120 \
pnpm benchmark:expose-queue
```

Run it on the change under test. The old global queue should show
`maxInFlight: 1` and a `startSpanMs` close to the sum of the per-request
delays. The per-expose queue should start independent exposes concurrently;
the browser's own connection limit can still make `maxInFlight` lower than the
number of exposes. The base-revision workflow is shown below.

When the benchmark is only present on the pull request branch, run it against
the base revision by copying the tracked test into a clean base worktree:

```sh
git worktree add /tmp/module-federation-vite-main origin/main
cd /tmp/module-federation-vite-main
pnpm install --frozen-lockfile
git checkout fix/1041-expose-load-parallelism -- integration/expose-queue.benchmark.test.ts
EXPOSE_QUEUE_BENCHMARK=1 pnpm exec vitest run \
  integration/expose-queue.benchmark.test.ts --reporter=verbose
```

This benchmark is intended for before/after comparison, not for a fixed
absolute performance assertion. The total bytes are intentionally unchanged;
the measured difference is request scheduling and waterfall latency.

## Safari/TLA safety

The expose scheduler is not the shared-module readiness barrier. Independent
exposes may load in parallel because the generated federation graph resolves
shared and remote dependencies through explicit Promises:

- `loadShare` tracks deferred shared exports in `pendingShareLoads`.
- `remoteEntry.get()` waits for those pending loads before invoking an expose.
- remote named-export proxies publish `__mf_remote_dependency_pending` instead
  of generating a top-level `await`.
- host bootstrap awaits the optional `__tla` promise before reading `initHost`.

The integration regression in
`integration/shared-cache-deferred-exports.test.ts` builds the shared remote
with `target: 'safari14'` and parses every generated chunk for a top-level
`await`. The benchmark itself measures the waterfall only; it is not a Safari
compatibility test.
