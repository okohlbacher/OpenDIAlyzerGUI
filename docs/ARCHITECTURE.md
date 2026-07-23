# Architecture

Cross-platform desktop application, TypeScript, Electron. Reads DIA-NN and
OpenDIAlyzer results; reads raw data through mzPeak by byte range.

## The shape, in one diagram

```
┌──────────────────────────────────────────────────────────────┐
│  RENDERER  (sandboxed, no Node)                              │
│  React + TS · three panes · SVG line charts · Canvas heat    │
│  ─────────────────────────────────────────────────────────   │
│  WEB WORKER — the data layer, and it is portable             │
│    hyparquet (index/footers)  ·  parquet-wasm (bulk)         │
│    spectrum offset table  ·  tile cache  ·  query cache      │
│                          │                                   │
│                   RangeReader  ← the one interface           │
│                     read(offset, length) → bytes             │
└──────────────────────────┼───────────────────────────────────┘
                    ┌──────┴──────┐
              file:// via IPC   https:// via fetch
                    │                │
┌───────────────────┼────────────────┼─────────────────────────┐
│  MAIN  (Node)     │                └─ (phase 5, object store)│
│    fs range reads · window · menus · sidecar supervision      │
│         │                                                     │
│         ├── mzpeak-convert   (Rust binary, spawned)           │
│         └── odia             (C++ engine, spawned)            │
└───────────────────────────────────────────────────────────────┘
```

Three decisions carry the whole design. Everything else follows.

## Decision 1 — `RangeReader` is the only thing that knows what a file is

```ts
interface RangeReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
```

mzPeak is a **STORED** (uncompressed) ZIP of Parquet facets, so member offsets
are directly addressable, and Parquet row-group statistics let a reader skip to
the row groups covering an **RT** window (m/z is not indexed — see "Correction 1"
below). Nothing above this interface ever sees a path, a URL or a filesystem.

Two implementations, one written now:

| | Now | Phase 5 |
|---|---|---|
| Electron | `fs.read` in main, exposed over IPC | — |
| Browser / cloud | — | `fetch` with a `Range:` header |

This is the single speculative abstraction in the design, and `docs/ROADMAP.md`
argues why it earns its place: it is a day of work now against a rewrite of
every panel later, and it is what turns "cluster and cloud" from a port into a
second implementation of one interface.

It also buys something sooner: **the data layer runs unmodified in a plain
browser.** The read-only shareable result link is then a deployment question,
not an engineering one.

## Decision 2 — two tiers, and DuckDB-WASM is not one of them

An earlier draft of this document proposed DuckDB-WASM as a single engine for
both the report table and the raw facets. **Measurement killed it**, along with
two assumptions underneath it. See §"What mzPeak actually provides" below; the
short version:

- Every mzPeak facet nests its columns under **one top-level Arrow struct**
  (`point`, `chunk`, `spectrum`). DuckDB would need the Parquet member extracted
  from the ZIP or a custom VFS over the slice, and its struct handling buys
  nothing over a plain Arrow reader for this schema.
- **`hyparquet` cannot project inside a struct** — it matches only
  `path_in_schema[0]`, so asking for `spectrum.time` throws. You always decode
  every leaf. That is structural, not a bug we can route around.

So: **two tiers, split by cost, not by convenience.**

| Tier | Engine | Handles | Measured |
|---|---|---|---|
| **Cheap** | `hyparquet` (pure JS, no build) | ZIP central directory, `mzpeak_index.json`, Parquet footers, page indexes, chromatogram facet | **2.9–7.1 ms** cold open on a 1.5 GB archive |
| **Bulk** | `parquet-wasm` + `apache-arrow` JS | Peak facets, metadata facet, everything with real volume | 20–50× faster than hyparquet; ~2–5× slower than native |

The cheap tier in pure JS is genuinely fast — single-digit milliseconds — and
needs no WASM at all. The bulk tier must not be pure JS: a full scan of a 16.7 M
point Astral file measured **17.4 s in hyparquet against 0.14–0.41 s native.**

The **report table** (`report.parquet`, millions of rows) also goes through the
bulk tier. It is a flat schema, so it is the easy case.

### The escalation, documented in advance

`parquet-wasm` is the starting point because it is one implementation that runs
in Electron *and* in a browser, with no native build matrix. If spike 2 shows
the drilldown budget cannot be met, the documented escalation is a **`napi-rs`
addon linking `mzpeak_prototyping`** — which additionally brings the TOF
transform, numpress, and `object_store` async remote reads for free
(`vendor/mzpeak_prototyping/src/reader/object_store_async.rs`). It costs a
{macOS, Windows, Linux} × {x64, arm64} × Electron-ABI prebuild matrix, forever.

That trade is genuinely close. It is deliberately *not* being decided from an
armchair: `RangeReader` and the tier boundary make the swap contained, and
spike 2 decides it with a number.

**Spike 2's number, for the query that matters:** `test/peaks.test.ts`'s "RT-
bounded XIC meets the 350 ms budget" runs the exact query the evidence panel
issues — bounded m/z × RT, real fragments, on the real 1.53 GB / 507 M-peak
timsTOF archive — against a 350 ms budget and has passed since M0-M2
(`1f88876`). Current measurement: **147 ms**, close to the 105 ms native
reference above it in this document. For the app's actual drilldown path,
the pure-JS tier already meets budget; this does not by itself resolve the
*random* spectrum fetch case (~500 ms pure JS, cited above), but that
pattern is not one the evidence panel's bounded queries exercise.

`// ponytail: WASM first because it is one build and one codebase. Escalate to
// napi-rs only on a measured miss, not because native sounds faster.`

## Decision 3 — native code runs as a sidecar, not as a linked module

Regardless of how Decision 2 lands, the two big native components stay
**spawned subprocesses**:

| Sidecar | What | Why not in-process |
|---|---|---|
| `mzpeak-convert` | Rust; vendor formats → `.mzpeak` | Already exists as a CLI. Thermo `.raw` needs a .NET 8 runtime, Bruker needs `libtimsdata` — ABI problems that stay outside our process |
| `odia` | C++ engine, links OpenMS | Long-running, must survive a GUI restart, and in phase 5 runs on another machine entirely |
| `diann` | The user's own DIA-NN install | **Never shipped by us.** Detected, verified and invoked — see `docs/DIANN-COMPAT.md` |

We ship the first two as versioned artefacts. The third is found on the user's
machine, and the distinction is deliberate: we invoke DIA-NN, we never
redistribute it.

### The engine interface

Two real implementations exist — DIA-NN today, `odia` when it is ready — so this
abstraction is describing the world rather than anticipating it.

```ts
interface Engine {
  readonly id: 'diann' | 'odia';
  detect(): Promise<Install[]>;              // version, edition, runtime deps
  capabilities(install: Install): Caps;      // which presets/features are real
  plan(job: Job): Stage[];                   // → cfg files; previewable, hashable
  run(stage: Stage, sink: EventSink): Handle;// spawn, stream, cancel
}
```

`plan()` returning inspectable stages rather than running anything is the load-
bearing part. It makes the invocation previewable before launch (DIA-NN's GUI
prints its command line only *after* starting the process), hashable into the
provenance record, and — because a stage is just a config file plus an argv — it
is the same object whether it executes locally or on a cluster in phase 5.

`// ponytail: an interface with two implementations, both of which exist. That
// is the bar; a third would not change the shape.`

## What mzPeak actually provides — measured, not assumed

Investigated against `mzPeakConverter` v0.6.0 and freshly converted corpora.
This section replaces the earlier "pending" placeholder, and it corrects two
claims that were wrong.

### Confirmed — the container works as hoped

Every archive member is **`CompressionMethod::Stored`**, ZIP64, and the reader
hard-refuses anything else (`vendor/mzpeak_prototyping/src/archive/sync.rs:59`,
`:606-614`). It is a CI-enforced invariant. So member offsets are computable
from the central directory and every Parquet byte offset is
`memberStart + parquetOffset`. **`RangeReader` is sound.**

| Operation | Measured |
|---|---|
| Cold open — ZIP CD + `mzpeak_index.json` + 5 Parquet footers | **2–14 ms** (native), **2.9–7.1 ms** (pure JS) |
| RT axis / TIC / BPC / MS-level overview | **2–12 ms** |
| **m/z 500–510 × RT 30–32 min** on a 1.53 GB, 507 M-peak timsTOF archive | **105–115 ms**, 54 MB read, 18 of 484 row groups |
| Random spectrum fetch | 24–34 ms native, ~500 ms pure JS |

**The primary drilldown is affordable.** 105 ms for a bounded m/z × RT window is
inside budget, and it is the query the evidence panel actually issues — because
`RT.Start`/`RT.Stop` come from the report row.

### Correction 1 — there is no m/z index. None.

I previously wrote that "row-group statistics let a reader seek to an m/z × RT
region". **That is true for RT and false for m/z.**

Rows are ordered `(spectrum, m/z)`, and a page holds hundreds of complete
spectra, so **every page spans the full m/z axis**:

```
Astral   point.mz  : 8 pages/rg — page0 [150.026 … 1997.259], pageLast [150.025 … 1995.731]
timsTOF  point.tof : 4 pages/rg — page0 [24 … 407550],        pageLast [12 … 407579]
```

m/z pruning yields **exactly zero**. Bloom filters are requested by the writer
(`base.rs:1098/1146/1298`) but `bloom_filter_offset` is **absent from every
column chunk of every file inspected**. So:

> **mzPeak today is an RT-indexed, m/z-unindexed format.**

The consequence is stark and it is a UI constraint, not just an engineering one:

| Query | Cost |
|---|---|
| m/z window **with** an RT bound (±1 min) | 105 ms, 54 MB |
| m/z window over the **whole run** | **2.97 s, 1443 MB, all 484 row groups** |

**Every raw query the UI issues must be RT-bounded.** For an identified
precursor that is free. For *Interrogate* — question 2, a peptide with no
measured RT — we bound by **predicted** RT ± a stated tolerance and say so in
the panel. An unbounded full-run XIC is offered only behind an explicit,
cost-labelled action, per interaction rule 9.

### Correction 2 — the grid facet does not exist, and would not help if it did

I previously specified the neighbourhood map's coarse pass as "rendered from
mzPeak's pre-binned grid facet". **There is no such facet.**
`GRID-FACET-DESIGN.md` is a DRAFT with *no code* — `grep` for
`grids.parquet|grid_facet|--grid-facet` across `src/` and `vendor/` returns
nothing. And it is not a rendering grid: it proposes one row per
`(grid_id, segment)` holding **calibration coefficients** to deduplicate
TOF→m/z models. There is no pre-binned intensity grid, no resolution levels, no
overview pyramid, proposed or implemented, anywhere.

What is free as an overview, in 2–12 ms: the TIC and BPC chromatograms, and
per-spectrum `total_ion_current` / `base_peak_mz` / `base_peak_intensity` from
the metadata facet. **That is a 1-D RT overview and nothing more.**

**So we build and persist our own tile pyramid**, outside the archive, keyed by
content hash. First paint of a region costs a bounded scan; thereafter it is a
cache hit. This is now an explicit component rather than something assumed free.
The upstream fix — a materialised m/z × RT overview facet at 2–3 resolution
levels — is worth proposing to the converter project, but this design must not
depend on it.

### Two discoveries from writing the reader, neither in the research

**`spectra_metadata.parquet` is not one row per spectrum.** It packs four
independent streams — `spectrum`, `scan`, `precursor`, `selected_ion` — of
*different lengths* into one shared row space, null-padding the shorter ones,
batch by batch. Measured on the timsTOF corpus: **61,956 rows carrying 32,700
spectra and 61,956 precursors**, in 14 alternating runs (rows 0–4999 spectra,
5000–9471 precursor-only, 9472–14471 spectra, …).

So the facet's row count is `max(stream lengths)` and **row position is not
spectrum index**. Reading it the obvious way returns clean data through row 4999
and silent nulls thereafter. Each stream is individually in ascending index
order, which is what makes one pass enough — scatter by the declared index,
never by row position.

The precursor stream is not a detail to skip: it carries the isolation windows,
and **it is the DIA seek path.** Turning "the peptide at m/z 614.98 eluting at
8.87 min" into a set of rows is only possible through it.

**hyparquet cannot read past the first data page of a `DELTA_BINARY_PACKED`
column.** Measured cutoff: row **540,896** of `point.spectrum_index`, well
inside row group 0 of 484. It fails *silently* — rows come back with an
undefined struct rather than an error.

That is worse than slow, and it moves the tier boundary from a performance
decision to a correctness one:

> **The cheap tier is not merely slower on the peak facet. It is wrong on it.**

Confirmed against pyarrow: row 125,748,494 really does hold `spectrum_index =
10218`, exactly as the offset table predicts, with zero nulls in the facet. The
data is fine; the reader is not. `verifyOffsets()` therefore probes the readable
limit by binary search rather than assuming it, and reports coverage.

### Measured by our own code

| | Result |
|---|---|
| Cold open, 1.53 GB ZIP64, 42 members | **0.2–0.3 ms** |
| `SUM(number_of_peaks)` vs peak-facet rows | **507,184,228 = 507,184,228**, exact |
| Offset table sampled against real rows | every sample correct, small file and large |
| m/z prunability — widest row group's share of the TOF axis | **100.0 %** across all 484 groups. Confirms Correction 1 independently |
| DIA seek: m/z 1038.45 ± 1 min | **28 frames, 105k peak rows — 0.021 % of the file** |
| RT 30–32 min | frames 16912–18039, 3.4 % of the run |
| Metadata index build, 1.5 GB | 1.8 s — the cost of no struct projection. Cached per archive; the bulk tier fixes it |

The 0.021 % figure is the thesis in one number: an RT-bounded drilldown reads
a five-thousandth of the file.

### Traps that must be handled in our code

| Trap | Evidence | Our handling |
|---|---|---|
| **The reader's m/z filter is silently inert on timsTOF.** `-m 9000-9001` (physically impossible) returns the same non-empty data as `-m 500-510`. `mz_index` is built only for `ArrayType::MZArray`, and the timsTOF axis is `MS:1000786` + transform (`index.rs:701`) | verified empirically | **Never trust an upstream m/z predicate.** Reconstruct m/z = `(a + b·tof)²` from `ims_calibration` and apply our own mask |
| Random access is quantised to a **1,048,576-row** row group; the entity-index column has exactly one page per row group | measured 484/484, 607/607, 16/16 | Build a **per-spectrum row-offset table** by prefix-summing `MS_1003059_number_of_peaks` from the metadata facet — turns "which rows are spectrum N" into arithmetic. Highest-leverage optimisation available |
| **Latent panic on duplicate `spectrum.id`** — reproduced; `reader.rs:781` + `metadata.rs:1962` | measured | Never derive spectrum count from an ID map |
| Two encodings no JS Parquet library provides: **MS-Numpress linear** (the *default*, and lossy, for the chunked profile layout) and per-mobility-scan **delta cumsum** | `constants`, `bruker_native.rs:395` | Implement both in TS. Numpress ≈ 60 lines, cumsum ≈ 10 |
| Ion mobility cannot be pruned — the page-index path exists but **its only caller is commented out** (`reader/point.rs:608-611`), and the column has no cross-file ordering | measured: page0 and page1 both `[0.67, 1.3818]` | IM is a post-decode mask. Acceptable: peaks are mobility-major *within* a frame, so once a frame is decoded an IM slice is contiguous |
| The `archive-vs-chunked/` corpus is a **v0.4.14 snapshot** with `spectrum.time == 0.0` everywhere | measured | Do not calibrate against it. Convert fresh with ≥ v0.6.0 |

### What to ask the converter project for

None of this blocks us, and all of it is cheap writer-side:

1. **Sort a second facet by `(m/z bucket, spectrum_index)`**, or offer
   `--layout mz-major`. This alone makes m/z page pruning real.
2. **Emit a materialised m/z × RT overview facet** at 2–3 resolution levels.
   Removes our tile-cache component entirely.
3. **Shrink the peak-facet row group** (or set `data_page_row_count_limit`) so
   the entity index gets more than one page per group.
4. **Actually write the bloom filters** the writer already requests, or stop
   requesting them.
5. **Make `mz_index` transform-aware** so `MS:1000786` + `MS:1003825`
   participates in pruning instead of silently disabling the filter.

## TypeScript 7.0

TS 7.0 — the native Go compiler — reached GA on **8 July 2026**, two weeks
before this document. It is not a future migration; it is what we start on. The
constraints below are real and shape the toolchain.

### What changed that we must respect

| Change | Consequence here |
|---|---|
| **No stable programmatic compiler API until 7.1** | The binding constraint. Any tool that imports `typescript` is out |
| `strict` defaults to `true` | Fine — we want it. Still set it explicitly so the config reads the same on any version |
| `types` defaults to `[]` — `@types/*` no longer auto-included | Must list `["node"]`, `["vite/client"]` etc. explicitly, or globals silently vanish |
| `moduleResolution: "node"` / `"node10"` / `"classic"` removed | `"bundler"` for the renderer, `"nodenext"` for main |
| `baseUrl` removed | Path aliases via `paths` only, or relative imports |
| `module: "amd" / "umd" / "system" / "none"` removed | Not used |

### The toolchain, chosen for TS7 safety

| Need | Choice | Why it is safe |
|---|---|---|
| Type checking | `tsc --noEmit` | The compiler itself is the supported path |
| Transform + bundle | **Vite** (esbuild / Rollup) | Strips types itself; never touches the TS compiler API |
| Tests | **Vitest** | esbuild-based, same reason |
| Packaging | **electron-builder** | No TS API involvement |

**Explicitly excluded, and why:** `ts-morph` (every call maps to the old API),
`tsup --dts` (declaration generation goes through the API), `ts-jest` (breaks
when aliased to the native compiler). None of these appear in the dependency
tree, and a CI check enforces that nothing imports `typescript` at build time.

We also do not emit `.d.ts` files at all — this is an application, not a
library, so the one workflow most affected by the missing API is one we never
run.

### `tsconfig.base.json`

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "strict": true,                    // default in 7.0; explicit for clarity
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,           // required by esbuild/Vite anyway
    "noEmit": true,                    // Vite emits; tsc only checks
    "types": []                        // 7.0 default; per-project overrides below
  }
}
```

Three projects extend it: `main` (`module`/`moduleResolution: "nodenext"`,
`types: ["node"]`), `preload` (same, narrow), and `renderer`
(`moduleResolution: "bundler"`, `lib: ["ES2023","DOM"]`,
`types: ["vite/client"]`, `jsx: "react-jsx"`).

Pin `typescript` to an exact version and treat compiler upgrades as deliberate
changes — 7.1 will restore the API and may change behaviour again.

## Electron process model

| Process | Runs | Owns |
|---|---|---|
| **main** | Node | Windows, menus, `fs` range reads, sidecar lifecycle, the engine job queue |
| **preload** | isolated bridge | A narrow, typed `window.odia` surface. No `require`, no raw `fs` |
| **renderer** | sandboxed | The UI. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP |
| **worker** | renderer Web Worker | The two Parquet tiers, the archive index, the spectrum offset table, the tile cache |

Security posture is the Electron default-secure one, not a relaxation of it. The
renderer opens files it was handed, never paths it constructed. External links
open in the system browser; `will-navigate` and `setWindowOpenHandler` are
locked down.

**Why the data layer lives in a renderer worker rather than in main:** it keeps
the same code running in a browser for phase 5, and it keeps main free to
supervise sidecars. Only `RangeReader` crosses the IPC boundary, and it crosses
it as bytes.

## The memory contract

The clearest lesson in the whole competitive record, from Skyline's own
maintainer:

> *"When Windows does not have enough RAM to hold everything that a C# program
> needs, **things really do slow suddenly down by a factor of about a
> million**."*

Skyline does not degrade past its working set — it falls off a cliff, because
the garbage collector must walk the whole heap. That produced 66 GB and 1 TB
chromatogram caches, three-day loads, and a maintainer recommending twelve
separate OS processes to dodge GC. **A managed-runtime heap is a managed-runtime
heap; a WASM linear heap fails the same way if we ever materialise a run.**

So three hard rules, and they are testable:

1. **Bounded working set.** Memory is a function of the *viewport*, not of the
   experiment. Adding the 500th run must not raise peak RSS. The tile cache and
   the query cache are both LRU with an explicit ceiling.
2. **No monolithic cache, ever.** Skyline's "Joining" step — merging per-replicate
   temporary caches into one `.skyd` — is its peak-memory moment and the source
   of every horror story. Brendan MacLean floated per-replicate caches in 2019
   and it never shipped. **Our per-run artefacts stay per-run**; the joined view
   is a query, not a file.
3. **Concurrency scales with the machine.** No magic constant. Skyline caps
   extraction at 12 files regardless of core count, in 2026.

A benchmark that holds peak memory flat from 10 runs to 1,000 is the single most
persuasive artefact this project could publish, because the incumbent's own
support forum documents the opposite.

## Rendering

Directly informed by Spectronaut shipping a *"you are almost out of GUI
handles"* warning: never one native control, and never one DOM node, per data
point.

| Surface | Technique | Reason |
|---|---|---|
| XIC / mirror / isotope charts | **SVG**, ~100–1000 points | Crisp, themeable with CSS variables, and *exports as vector* with no second code path |
| Neighbourhood heat map, dense scatter | **Canvas 2D** | Thousands of cells; DOM would die. Exports as PNG |
| Match table | **Virtualised rows** | Only visible rows exist. A 5M-row report is a query, never an array |

`docs/mockup.html` implements exactly this split and is the working reference —
including the theme-reactive Canvas redraw, which is the only fiddly part
(Canvas cannot inherit CSS variables, so the ramp is re-read and the map
repainted on theme change).

No charting library. The chart types are six, they are all small, and every
library in this space would have to be fought to accept a shared cursor and a
cancellable async data source. `// ponytail: six chart functions, ~200 lines.
Add a library when there are twenty.`

## Data flow of one drilldown

The interaction that must stay under ~100 ms, because `↑`/`↓` through a
candidate list is the core loop:

```
↓ keypress
  → selection store updates (synchronous, renderer)
  → previous in-flight queries cancelled
  → tile cache hit?  → paint coarse immediately
  → worker: RT window from report row (RT.Start/RT.Stop ± margin)
      → offset table + RT page index → row-group ranges
      → RangeReader.read() → parquet-wasm → Arrow columns
      → our own m/z mask (never trust the upstream predicate — timsTOF)
  → charts refine to exact peaks
  → prefetch N±1 in the background
```

Three properties make it feel instant rather than merely be fast:
**cancellation** (scrolling past ten rows issues and abandons nine queries),
**coarse-first** from the tile cache, and **prefetch** of the adjacent rows,
which is what actually hides the latency in the dominant `↑`/`↓` loop.

**Every raw query is RT-bounded.** That is not an optimisation, it is the only
thing that makes the query affordable — 105 ms bounded against 2.97 s
unbounded, measured. The bound comes from the report row for an identified
precursor, and from predicted RT ± a stated tolerance for *Interrogate*.

## Result store

One logical table, two producers, described in `docs/DIANN-COMPAT.md`. The
loader reads the Parquet schema, maps known columns to canonical names, and
carries unknown columns through untyped. It never fails on an unrecognised
column and never assumes one is present — because DIA-NN adds columns per
release and gates some behind Enterprise.

Native OpenDIAlyzer output is the same schema plus `ODIA.`-prefixed columns.
There is no adapter layer and no format registry: two producers, one schema.

## Spikes — done, and the one that was skipped

The plan review made a sharp point: the original spike list validated mzPeak
*reading*, which the measurements above had already settled, and skipped the
genuine unknown — the engine run plan. Corrected.

**Settled in shipped code** (the original spikes 1–3):

1. **Offset table** — prefix-sum `MS_1003059_number_of_peaks` predicts peak-facet
   rows exactly, tested on Thermo and Bruker (`test/spectra.test.ts`).
2. **XIC round-trip through `parquet-wasm`** — 178 ms measured; Decision 2's
   escalation is closed, parquet-wasm stays (`test/peaks.test.ts`).
3. **Cold-open a report** — 576 ms for 268,948 × 72 (`test/report.test.ts`).

**Spike 0 — the one that actually matters, and is not yet run.** Does the
`calibrate → per-run → aggregate` split reproduce a monolithic DIA-NN run? Every
Phase-1 value claim (per-file isolation, checkpoint, order-independence, cluster
re-queue) inherits from it, and it is **untestable on this machine** — DIA-NN has
no macOS build. It must run on Linux/Windows or in CI: search two files
monolithically, then split, diff the reports. Until it passes, `docs/DIANN-COMPAT.md`'s
run plan is a design, not a guarantee.

**Still ahead:**

4. **The tile pyramid** — build one for a run, measure first-paint and cache-hit,
   size the cache. And the plan review's catch: in the *browser* build this
   cannot be built client-side (it would mean downloading the whole 8–14 GB
   archive over HTTP), so the pyramid must be produced at convert time or
   server-side and shipped beside the archive. The browser story is read-only
   results viewing over a pre-built pyramid, and the roadmap should say so plainly.
5. **One XIC round-trip over HTTP range from a home connection** — the browser
   build's real risk is latency, not bandwidth: a bounded XIC is several
   dependent round trips, and at 50–200 ms each the 178 ms local query becomes
   0.5–1.5 s unless ranges are coalesced and prefetch is aggressive.

Prefetching is the mitigation that makes spikes 2 and 5 matter less than they
look: stepping `↑`/`↓` is the dominant interaction, and prefetching N±1 hides
the latency for it entirely. Only a cold jump — `⌘K`, or clicking a distant
row — pays the full cost.
