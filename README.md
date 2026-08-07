# brepkit-bench

Reproducible head-to-head benchmark of [brepkit](https://github.com/andymai/brepkit)
against OCCT, both compiled to WebAssembly, driven through the same
[brepjs](https://github.com/andymai/brepjs) adapter layer.

**Every row is output-verified before any timing happens.** The harness asserts
that both kernels produce correct geometry (closed-form expected values where
they exist, cross-kernel agreement elsewhere) and refuses to time a row that
fails. A fast-but-wrong result cannot appear in the table.

## Run it

```bash
git clone https://github.com/andymai/brepkit-bench
cd brepkit-bench
npm install
npm run bench
```

Requires Node 20+. `npm run verify` runs only the correctness checks;
`npm run bench:json` also writes `results.json`.

All kernel versions are exact-pinned in `package.json` and `package-lock.json`:
[`brepkit-wasm`](https://www.npmjs.com/package/brepkit-wasm),
[`occt-wasm`](https://www.npmjs.com/package/occt-wasm) (OpenCascade compiled to
WebAssembly), and [`brepjs`](https://www.npmjs.com/package/brepjs) as the common
adapter layer, so adapter overhead is identical on both sides.

## Methodology

- 2 warmup runs, then 5 timed runs per row; the reported figure is the **median**.
- Single-threaded Node.js. Both kernels run in the same process, sequentially.
- Rows labeled x10 / x100 execute the operation that many times per run, exactly
  as labeled.
- Timing uses `performance.now()` around the operation loop only; kernel
  initialization is excluded.

## What each row does, and how it is verified

| Row | Operation | Verification |
| --- | --------- | ------------ |
| fuse(box, box) x10 | `box(10,10,10) ∪ translate(box(5,5,5), 5,5,5)` | volume == 1000 exactly (tool fully contained) |
| cut(box, cylinder) x10 | `box(10,10,10) − cylinder(r=3, h=20)` | volume vs closed-form `1000 − 9π·10/4` within 0.05% |
| intersect(box, sphere) x10 | `box(10,10,10) ∩ sphere(r=8)` | volume vs closed-form spherical octant `π·8³/6` within 0.05% |
| box + chamfer | all 12 edges of `box(20,20,20)`, distance 1 | cross-kernel volume agreement within 1e-6 |
| box + fillet | all 12 edges of `box(20,20,20)`, radius 1 | cross-kernel volume agreement within 0.01% |
| multi-boolean (16 holes) | `box(50,50,10)` minus 16 translated cylinders | volume vs closed-form within 0.05% |
| mesh sphere (tol=0.01) | tessellate `sphere(r=10)` at tolerance 0.01, angular 0.1 | comparable densities (9,800 vs 10,176 triangles) and mesh surface area within 1% of `4π·10²` |
| volume(box) x100 | measure `box(10,10,10)` | volume == 1000 |
| exportSTEP x10 | write `box(10,10,10)` to STEP | valid ISO-10303-21 output, re-imports to volume 1000 |

Honesty notes:

- In the multi-boolean row, the 16 tool cylinders sit on a grid of which only 4
  intersect the stock; the other 12 are disjoint and exercise each kernel's
  reject path. Both kernels face identical work, and the closed-form check
  (`25000 − 4·9π·10`) covers the result.
- Deviation thresholds are stated per row above; measured agreement is printed
  on every run so you can judge it yourself (typical fillet cross-kernel
  agreement is ~0.004%).

## Native (non-WASM) numbers

brepkit also runs natively. The native column in brepkit's README comes from
criterion benchmarks in the brepkit repo:

```bash
git clone https://github.com/andymai/brepkit
cd brepkit
cargo bench -p brepkit-operations --bench cad_operations
```

The mesh-sphere native figure uses `crates/operations/examples/perf_probe.rs`
at the same parameters as the WASM row, because the criterion suite's sphere
case meshes per-face and is not comparable.

## Caveats

- WASM, single-threaded, one machine: absolute times vary by CPU and Node
  version (the harness prints both). Speedup ratios are far more stable than
  absolute times, but expect variance either way; run it on your own hardware.
- Both kernels pay the same brepjs adapter overhead; this benchmarks the
  kernels as a JS developer would actually consume them, not raw FFI calls.
- The OCCT build is [occt-wasm](https://github.com/andymai/occt-wasm), a
  current OCCT compiled to WebAssembly with standard flags. If you believe a
  different build configuration would be materially faster, issues and PRs are
  welcome.

## CI

The `bench` workflow can be triggered by anyone with a fork (Actions →
bench → Run workflow). It runs this same harness on a public GitHub runner and
publishes the table as the job summary. GitHub runners are noisy neighbors;
treat CI numbers as sanity checks, not measurements.

## License

MIT. The benchmarked kernels carry their own licenses:
[brepkit](https://github.com/andymai/brepkit) is AGPL-3.0-only with a
commercial option, [occt-wasm](https://github.com/andymai/occt-wasm)'s WASM
output is LGPL-2.1-only.
