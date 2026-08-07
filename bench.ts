/**
 * brepkit vs OCCT (WASM) head-to-head benchmark.
 *
 * Every row is OUTPUT-VERIFIED before any timing happens: the harness asserts
 * that both kernels produce the correct geometry (closed-form expected values
 * where they exist, cross-kernel agreement elsewhere). A row that fails
 * verification is never timed, so a fast-but-wrong result cannot appear in
 * the table.
 *
 * Methodology (matches the published brepkit README table):
 * - Both kernels are driven through the same brepjs adapter layer, so adapter
 *   overhead is identical on both sides.
 * - 2 warmup runs, then 5 timed runs per row; the reported figure is the
 *   median. Single-threaded Node.js.
 * - Boolean and exportSTEP rows execute the operation in batches (x10, x100)
 *   exactly as the row label states.
 */

import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  registerKernel,
  withKernel,
  BrepkitAdapter,
  OcctWasmAdapter,
} from 'brepjs';

const require = createRequire(import.meta.url);

type KernelId = 'brepkit' | 'occt-wasm';
const KERNELS: KernelId[] = ['brepkit', 'occt-wasm'];
const WARMUP = 2;
const ITERATIONS = 5;

// ---------------------------------------------------------------------------
// Kernel init (published packages only)
// ---------------------------------------------------------------------------

async function initKernels(): Promise<void> {
  const bk: any = await import('brepkit-wasm');
  if (typeof bk.default === 'function') await bk.default();
  const BrepKernel = bk.BrepKernel ?? bk.default?.BrepKernel;
  if (!BrepKernel) throw new Error('brepkit-wasm: could not resolve BrepKernel');
  registerKernel('brepkit', new BrepkitAdapter(new BrepKernel()));

  const { OcctKernel } = await import('occt-wasm');
  const k = await OcctKernel.init();
  registerKernel('occt-wasm', OcctWasmAdapter.fromKernel(k));
}

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

class VerificationError extends Error {}

function assertRel(actual: number, expected: number, relTol: number, msg: string): void {
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  if (!(rel <= relTol)) {
    throw new VerificationError(
      `${msg}: got ${actual}, expected ${expected} (rel err ${(rel * 100).toExponential(2)}% > ${(relTol * 100)}%)`
    );
  }
}

// Closed-form expected volumes
const V_FUSE = 1000; // box(10)^3 ∪ box(5)^3 at (5,5,5): tool fully contained
const V_CUT = 1000 - (Math.PI * 9 * 10) / 4; // quarter cylinder r=3 through h=10
const V_INTERSECT = (Math.PI * 8 ** 3) / 6; // spherical octant, r=8
const V_MULTI = 25000 - 4 * Math.PI * 9 * 10; // 4 of 16 tools intersect the stock
const V_BOX = 1000;
const SPHERE_AREA = 4 * Math.PI * 100; // r=10

// relative tolerances
const TOL_EXACT = 1e-6; // "exact" rows
const TOL_CLOSED = 5e-4; // closed-form vs mesh-integrated volume (0.05%)
const TOL_CROSS = 1e-4; // cross-kernel agreement (0.01%)

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface Row {
  name: string;
  /** The timed operation, exactly as the row label states. */
  run: (k: any) => void;
  /** Output verification, run once per kernel BEFORE timing. Returns a human-readable note. */
  verify: (k: any) => string;
  /** Optional cross-kernel check on the per-kernel verify results. */
  cross?: (a: number, b: number) => void;
  /** Numeric result captured by verify, for cross checks. */
  _measured?: Partial<Record<KernelId, number>>;
}

const rows: Row[] = [
  {
    name: 'fuse(box, box) (x10)',
    run: (k) => {
      for (let i = 0; i < 10; i++) {
        const a = k.makeBox(10, 10, 10);
        const b = k.translate(k.makeBox(5, 5, 5), 5, 5, 5);
        k.fuse(a, b);
      }
    },
    verify: (k) => {
      const v = k.volume(k.fuse(k.makeBox(10, 10, 10), k.translate(k.makeBox(5, 5, 5), 5, 5, 5)));
      assertRel(v, V_FUSE, TOL_EXACT, 'fuse volume');
      return `volume ${v} == ${V_FUSE}`;
    },
  },
  {
    name: 'cut(box, cylinder) (x10)',
    run: (k) => {
      for (let i = 0; i < 10; i++) {
        k.cut(k.makeBox(10, 10, 10), k.makeCylinder(3, 20));
      }
    },
    verify: (k) => {
      const v = k.volume(k.cut(k.makeBox(10, 10, 10), k.makeCylinder(3, 20)));
      assertRel(v, V_CUT, TOL_CLOSED, 'cut volume');
      return `volume ${v.toFixed(4)} vs closed-form ${V_CUT.toFixed(4)}`;
    },
  },
  {
    name: 'intersect(box, sphere) (x10)',
    run: (k) => {
      for (let i = 0; i < 10; i++) {
        k.intersect(k.makeBox(10, 10, 10), k.makeSphere(8));
      }
    },
    verify: (k) => {
      const v = k.volume(k.intersect(k.makeBox(10, 10, 10), k.makeSphere(8)));
      assertRel(v, V_INTERSECT, TOL_CLOSED, 'intersect volume (spherical octant)');
      return `volume ${v.toFixed(4)} vs closed-form octant ${V_INTERSECT.toFixed(4)}`;
    },
  },
  {
    name: 'box + chamfer',
    run: (k) => {
      const box = k.makeBox(20, 20, 20);
      const edges = k.iterShapes(box, 'edge');
      k.chamfer(box, edges, 1);
    },
    verify: (k) => {
      const box = k.makeBox(20, 20, 20);
      const v = k.volume(k.chamfer(box, k.iterShapes(box, 'edge'), 1));
      // No simple closed form for all-edge chamfer corners: sanity band per
      // kernel, exact agreement across kernels (checked in cross()).
      if (!(v < 8000 && v > 8000 - 12 * 0.5 * 20)) {
        throw new VerificationError(`chamfer volume ${v} outside sanity band`);
      }
      return `volume ${v.toFixed(6)}`;
    },
    cross: (a, b) => assertRel(a, b, TOL_EXACT, 'chamfer cross-kernel volume'),
  },
  {
    name: 'box + fillet',
    run: (k) => {
      const box = k.makeBox(20, 20, 20);
      const edges = k.iterShapes(box, 'edge');
      k.fillet(box, edges, 1);
    },
    verify: (k) => {
      const box = k.makeBox(20, 20, 20);
      const v = k.volume(k.fillet(box, k.iterShapes(box, 'edge'), 1));
      if (!(v < 8000 && v > 8000 - 12 * 0.5 * 20)) {
        throw new VerificationError(`fillet volume ${v} outside sanity band`);
      }
      return `volume ${v.toFixed(6)}`;
    },
    cross: (a, b) => assertRel(a, b, TOL_CROSS, 'fillet cross-kernel volume'),
  },
  {
    name: 'multi-boolean (16 holes)',
    run: (k) => {
      let result = k.makeBox(50, 50, 10);
      for (let x = -15; x <= 15; x += 10) {
        for (let y = -15; y <= 15; y += 10) {
          result = k.cut(result, k.translate(k.makeCylinder(3, 20), x, y, -5));
        }
      }
    },
    verify: (k) => {
      let result = k.makeBox(50, 50, 10);
      for (let x = -15; x <= 15; x += 10) {
        for (let y = -15; y <= 15; y += 10) {
          result = k.cut(result, k.translate(k.makeCylinder(3, 20), x, y, -5));
        }
      }
      const v = k.volume(result);
      assertRel(v, V_MULTI, TOL_CLOSED, 'multi-boolean volume');
      return `volume ${v.toFixed(4)} vs closed-form ${V_MULTI.toFixed(4)}`;
    },
  },
  {
    name: 'mesh sphere (tol=0.01)',
    run: (k) => {
      k.mesh(k.makeSphere(10), { tolerance: 0.01, angularTolerance: 0.1 });
    },
    verify: (k) => {
      const m = k.mesh(k.makeSphere(10), { tolerance: 0.01, angularTolerance: 0.1 });
      const tris = triangleCount(m);
      if (!(tris > 5000 && tris < 20000)) {
        throw new VerificationError(`sphere mesh density ${tris} triangles outside comparable band`);
      }
      const area = meshArea(m);
      if (area !== null) assertRel(area, SPHERE_AREA, 0.01, 'sphere mesh surface area');
      return `${tris} triangles${area !== null ? `, area ${area.toFixed(2)} vs ${SPHERE_AREA.toFixed(2)}` : ''}`;
    },
  },
  {
    name: 'volume(box) (x100)',
    run: (k) => {
      const box = k.makeBox(10, 10, 10);
      for (let i = 0; i < 100; i++) k.volume(box);
    },
    verify: (k) => {
      const v = k.volume(k.makeBox(10, 10, 10));
      assertRel(v, V_BOX, TOL_EXACT, 'box volume');
      return `volume ${v} == ${V_BOX}`;
    },
  },
  {
    name: 'exportSTEP (x10)',
    run: (k) => {
      const box = k.makeBox(10, 10, 10);
      for (let i = 0; i < 10; i++) k.exportSTEP([box]);
    },
    verify: (k) => {
      const out = k.exportSTEP([k.makeBox(10, 10, 10)]);
      const text = typeof out === 'string' ? out : Buffer.from(out).toString('utf-8');
      if (!text.startsWith('ISO-10303-21')) {
        throw new VerificationError('exportSTEP output is not a STEP file');
      }
      if (typeof k.importSTEP === 'function') {
        const back = k.importSTEP(out);
        const shape = Array.isArray(back) ? back[0] : back;
        const v = k.volume(shape);
        assertRel(v, V_BOX, TOL_CROSS, 'STEP round-trip volume');
        return `valid STEP, round-trip volume ${v}`;
      }
      return 'valid STEP header';
    },
  },
];

// ---------------------------------------------------------------------------
// Mesh helpers (tolerant of adapter mesh field naming)
// ---------------------------------------------------------------------------

function meshFields(m: any): { positions: ArrayLike<number> | null; indices: ArrayLike<number> | null } {
  const positions = m?.positions ?? m?.vertices ?? m?.vertexArray ?? null;
  const indices = m?.indices ?? m?.triangles ?? m?.indexArray ?? null;
  return { positions, indices };
}

function triangleCount(m: any): number {
  const { indices } = meshFields(m);
  if (indices) return Math.floor(indices.length / 3);
  const { positions } = meshFields(m);
  if (positions) return Math.floor(positions.length / 9);
  throw new VerificationError(`mesh has no recognizable index/position fields: ${Object.keys(m ?? {}).join(',')}`);
}

function meshArea(m: any): number | null {
  const { positions, indices } = meshFields(m);
  if (!positions || !indices) return null;
  let area = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = 3 * (indices[i] as number);
    const b = 3 * (indices[i + 1] as number);
    const c = 3 * (indices[i + 2] as number);
    const abx = (positions[b] as number) - (positions[a] as number);
    const aby = (positions[b + 1] as number) - (positions[a + 1] as number);
    const abz = (positions[b + 2] as number) - (positions[a + 2] as number);
    const acx = (positions[c] as number) - (positions[a] as number);
    const acy = (positions[c + 1] as number) - (positions[a + 1] as number);
    const acz = (positions[c + 2] as number) - (positions[a + 2] as number);
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    area += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
  }
  return area;
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function timeRow(row: Row, kernel: KernelId): number {
  return withKernel(kernel, () => {
    const k = kget();
    for (let i = 0; i < WARMUP; i++) row.run(k);
    const times: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      row.run(k);
      times.push(performance.now() - t0);
    }
    return median(times);
  });
}

// getKernel is fetched lazily so withKernel's context applies
import { getKernel } from 'brepjs';
function kget(): any {
  return getKernel();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function pkgVersion(name: string): string {
  try {
    return (require(`${name}/package.json`) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function fmtMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(1)} ms`;
}

async function main(): Promise<void> {
  const jsonOut = process.argv.includes('--json');
  const verifyOnly = process.argv.includes('--verify-only');

  console.log('Initializing kernels...');
  await initKernels();

  console.log(`\nEnvironment: Node ${process.version}, ${os.platform()} ${os.arch()}, ${os.cpus()[0]?.model ?? 'unknown CPU'}`);
  console.log(`Packages: brepjs ${pkgVersion('brepjs')}, brepkit-wasm ${pkgVersion('brepkit-wasm')}, occt-wasm ${pkgVersion('occt-wasm')}`);

  // ---- Verification pass (always) ----
  console.log('\n== Output verification (before any timing) ==');
  let failed = 0;
  for (const row of rows) {
    row._measured = {};
    for (const kernel of KERNELS) {
      try {
        const note = withKernel(kernel, () => {
          const k = kget();
          const msg = row.verify(k);
          const num = parseFloat((msg.match(/volume ([0-9.]+)/) ?? [])[1] ?? 'NaN');
          if (!Number.isNaN(num)) row._measured![kernel] = num;
          return msg;
        });
        console.log(`  PASS  ${row.name} [${kernel}]: ${note}`);
      } catch (e) {
        failed++;
        console.error(`  FAIL  ${row.name} [${kernel}]: ${(e as Error).message}`);
      }
    }
    if (row.cross) {
      const a = row._measured['brepkit'];
      const b = row._measured['occt-wasm'];
      if (a !== undefined && b !== undefined) {
        try {
          row.cross(a, b);
          console.log(`  PASS  ${row.name} [cross-kernel]`);
        } catch (e) {
          failed++;
          console.error(`  FAIL  ${row.name} [cross-kernel]: ${(e as Error).message}`);
        }
      }
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} verification check(s) failed. Refusing to time unverified rows.`);
    process.exit(1);
  }
  console.log('\nAll rows verified on both kernels.');
  if (verifyOnly) return;

  // ---- Timing pass ----
  console.log('\n== Timing (median of 5, after 2 warmups) ==\n');
  const results: { name: string; brepkit: number; occt: number }[] = [];
  for (const row of rows) {
    const brepkit = timeRow(row, 'brepkit');
    const occt = timeRow(row, 'occt-wasm');
    results.push({ name: row.name, brepkit, occt });
    console.log(`  ${row.name}: brepkit ${fmtMs(brepkit)}, occt-wasm ${fmtMs(occt)}`);
  }

  // ---- Report ----
  const lines: string[] = [];
  lines.push('| Operation | brepkit (WASM) | OCCT (WASM) | Speedup |');
  lines.push('| --------- | -------------- | ----------- | ------- |');
  for (const r of results) {
    const speedup = r.occt / r.brepkit;
    lines.push(`| ${r.name} | ${fmtMs(r.brepkit)} | ${fmtMs(r.occt)} | ${speedup.toFixed(1)}x |`);
  }
  const table = lines.join('\n');
  console.log(`\n${table}\n`);

  if (jsonOut) {
    fs.writeFileSync(
      'results.json',
      JSON.stringify(
        {
          date: new Date().toISOString(),
          node: process.version,
          cpu: os.cpus()[0]?.model,
          packages: {
            brepjs: pkgVersion('brepjs'),
            'brepkit-wasm': pkgVersion('brepkit-wasm'),
            'occt-wasm': pkgVersion('occt-wasm'),
          },
          results,
        },
        null,
        2
      )
    );
    console.log('Wrote results.json');
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(
      summaryPath,
      `## brepkit vs OCCT (WASM)\n\nNode ${process.version}, ${os.cpus()[0]?.model ?? ''}\n\n${table}\n\nAll rows output-verified before timing.\n`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
