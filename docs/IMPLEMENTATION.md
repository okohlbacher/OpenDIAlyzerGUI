# Implementation order

Every milestone is runnable and measurable on its own. The order is by **risk,
not by layer** — the assumptions most likely to be wrong get tested first, with
no UI in the way.

No milestone is a prerequisite refactor for the next.

| | Milestone | Ships | Kills the risk that… |
|---|---|---|---|
| **M0** ✅ | Range reader + ZIP directory | Opens a 1.53 GB ZIP64 archive in **0.2 ms** | …the archive is not byte-addressable from TS |
| **M1** ✅ | Spectrum + precursor index | Offset table **exact to the row** (507,184,228); DIA seek path working | …`number_of_peaks` does not predict peak-facet rows |
| **M2** ✅ | RT-bounded XIC | End-to-end fragment traces in **178 ms** (native: 105 ms) | …`parquet-wasm` cannot meet the drilldown budget |
| **M3** ✅ | Report loader | A DIA-NN `report.parquet` as a filterable table | …schema drift breaks the drop-in promise |
| **M4** | Shell | Electron window, three panes, real data in the table | …the mockup does not survive real column counts |
| **M5** | Drilldown | Selection → evidence panel, end to end | — |
| **M6** | Engine | Detect, verify, plan, run DIA-NN | …the calibrate→per-run→aggregate plan does not hold |

M0–M3 are **plain Node modules with no Electron and no UI.** They are the parts
that can be wrong in expensive ways, so they get tested in isolation with
`node --test` against real files.

## Stack, and why each piece is the lazy choice

| Choice | Reason |
|---|---|
| **TypeScript, run directly by Node 26** | Node strips types natively. No `tsc`, no bundler, no build step for the core. `tsc --noEmit` in CI is the only type-check |
| **`node --test`** | Stdlib. No jest, no vitest, no config |
| **`hyparquet`** | Pure JS, no build step, and fast enough for the cheap tier (2.9–7.1 ms cold open, measured) |
| **`parquet-wasm` + `apache-arrow`** | The bulk tier. Deferred to M2 — M0/M1 do not need it |
| **Hand-written ZIP reader** | ~120 lines. Every JS unzip library wants the whole member in memory, which is precisely what we must not do |

`// ponytail: no build step, no test framework, no bundler until something
// measurably needs one.`

## Test data

| File | Size | Use |
|---|---|---|
| `hupo-mzpeak/small.mzpeak` | 2 MB, 6 members | Fast iteration, every unit test |
| `hupo-mzpeak/small.unpacked.mzpeak/` | directory | Cross-check the ZIP reader against plain files |
| `mzpeak-example-data/…_8225.mzpeak` | 1.53 GB, 507 M peaks, v0.6.0 timsTOF | Real latency numbers |
| `archive-vs-chunked/*.mzpeak` | 6 × ~1.5 GB, **v0.4.14** | Known-bad corpus: `spectrum.time == 0.0`, duplicate IDs. Regression fodder only — never calibrate against it |

## Budgets, asserted in tests rather than hoped for

| Operation | Budget | Native baseline |
|---|---|---|
| Cold open (ZIP CD + index + footers) | < 50 ms | 2–14 ms |
| Spectrum by index | < 150 ms | 24–34 ms |
| RT-bounded XIC | < 350 ms | 105 ms |
| Report table, first row | < 500 ms | — |

A test that fails on a budget miss is the only thing that keeps the memory
contract in `docs/ARCHITECTURE.md` honest.

## Status

**M0–M4 are done.** 25 tests green, and the app runs on real DIA-NN 2.6.1
output: three panes, FDR slider, run filter, search, keyboard stepping, and an
evidence pane that reads raw data on selection.

```bash
npm run app
```

### One deliberate deviation from the architecture

`docs/ARCHITECTURE.md` puts the data layer in a renderer Web Worker so it also
runs in a browser. For M4 it lives in the **Electron main process** instead:
main is plain Node, so `parquet-wasm`, `openAsBlob` and `fs` work with no
bundling at all. The renderer only ever sees message passing, so relocating it
to a worker later is a swap rather than a rewrite. The browser build is deferred,
not designed out.

Second, smaller one: main is bundled as **ESM** (`main.mjs`) because hyparquet
is ESM-only and a CJS bundle cannot require it. Preload stays CJS.

### The demo dataset

A six-run human liver diaPASEF cohort searched with DIA-NN 2.6.1 Academia,
provided by a collaborating group. The data itself is unpublished and is not
in this repository; only the measurements taken against it are.

It is a better exercise than a benchmark corpus would have been, because the
study's own question *is* question 2: **is a specific variant peptide present
in this sample, and if not, what is actually at that coordinate?**

### M6 — Proteins and Runs grains

Both were visible-but-disabled since M4. They aggregate the **filtered**
precursor set, so the FDR slider moves all three grains together — which is the
design's claim and the thing DIA-NN's matrices famously do not do
([#1056](https://github.com/vdemichev/DiaNN/issues/1056) took three rounds with
the author to reconstruct which filter produced the matrix). Protein numbers are
derived here, never read from `report.pg_matrix.tsv`. One source of truth.

**QC is the Runs grain, not a separate screen** — the claim `docs/UI-DESIGN.md`
made and could not previously back. On this cohort it immediately shows one run
is shallower than the rest:

| | precursors | proteins | FWHM |
|---|---|---|---|
| S30 | 49,213 | 6,223 | 3.7 s |
| S26 | 48,885 | 6,193 | 3.6 s |
| **S23** | **38,613** | **4,669** | 3.6 s |

Peak width is uniform, so that is depth rather than chromatography.

A test asserts the runs partition the filtered set exactly and that no precursor
is counted twice or dropped across protein groups — the arithmetic that has to
hold for the grains to be the same evidence rather than three different answers.

### M5 — Interrogate

Question 2 — *why is my peptide missing?* — in the form it actually takes: a
precursor identified in some runs of a cohort and absent from others. In this
report **7,084 precursors are found in exactly four runs of six**, and 17,773 in
only one, so this is the common case rather than a corner.

Selecting a precursor shows a per-run strip: green where the engine identified
it with its q-value and RT, dashed amber where it did not. Clicking a missing
run extracts evidence there **from raw data**, computed from the sequence —
which is precisely what no engine can do, because none writes a chromatogram for
a candidate it rejected.

The retention time is **borrowed** from the runs that did find it, which is what
keeps the query RT-bounded and therefore ~900 ms rather than seconds. The panel
says so: a borrowed coordinate is an assumption, and the reader is entitled to
know which one was made.

**What the first working version got wrong, and why it mattered.** It reported
"signal is present — the peptide is there but went unreported" whenever any
trace was non-zero. The very first real case showed one strong fragment and five
flat ones — the signature of a co-incident ion in a wide isolation window, not a
peptide. The panel now counts how many fragments rise *together*:

| | |
|---|---|
| ≥3 co-eluting | consistent with the peptide being present but unreported |
| some present, not co-eluting | more consistent with interference |
| none | absent, not merely unscored |

`coelution()` lives in `src/peaks.ts` with a unit test, rather than in the UI,
because a tool that overstates its evidence is worse than one that shows less.

### The FDR slider, demonstrated

The same cohort searched twice — once at DIA-NN's default `--qvalue 0.01`, once
under our policy of writing everything at `--qvalue 0.5`:

| written at | rows | q ≤ 0.001 | q ≤ 0.01 | q ≤ 0.05 | q ≤ 0.5 |
|---|---|---|---|---|---|
| 1 % | 268,948 | 209,967 | 268,948 | 268,948 | 268,948 |
| **50 %** | **377,775** | 210,663 | 268,166 | **314,655** | **377,775** |

The 1 % report is **flat above 0.01**: the slider cannot go anywhere DIA-NN has
already discarded, so relaxing the threshold means re-running the search. The
50 % report keeps climbing. That is the whole of "FDR is not a setting" in one
table, and it costs 3× the report size — 37 MB against 109 MB.

DIA-NN's own log confirms the calibrate→pin plan took effect:

```
Output will be filtered at 0.5 FDR
Scan window radius set to 6
Mass accuracy will be fixed to 7e-06 (MS2) and 1e-05 (MS1)
```

*Fixed*, not optimised — so the result no longer depends on which run DIA-NN
happened to calibrate on, which is the documented cause of its run-order
sensitivity (#1766, #778).

`--export-quant` also brings fragment-level columns: 129 columns against 72, and
96 unrecognised ones carried through instead of 39. All 33 canonical columns
still present.

### The column contract was right

`docs/DIANN-COMPAT.md` listed the columns the UI depends on, derived from the
README before any real output existed. Against a real 268,948-row report:
**all 33 present, 39 unrecognised columns carried through, `File.Name` absent
exactly as DIA-NN #1105 documents.** The tolerance design was not theoretical.

| Measurement | |
|---|---|
| Load 268,948 × 72 | **576 ms** |
| Re-filter (the FDR slider) | **1.5 ms** — budget was one 16.7 ms frame |
| Mean engine-measured RT window | **0.174 min** — every one of 500 sampled under 2 min |

That last number matters more than it looks: the XIC was benchmarked against a
±0.5 min window, and real reports are three times tighter still.

### Twice now, the same mistake

Both M2 and M3 were first written with a per-row Arrow access in the hot path,
and both were ~20× too slow until it was removed.

- M2: `.get(i)` over a million peak rows — test exceeded 120 s.
- M3: a type check matching only `Float64Array | Int32Array`, so **56 of this
  report's columns were float32** and silently took the per-row fallback. Decode
  is 275 ms; the loop around it was 9 s.

The rule that would have prevented both: **never touch an Arrow vector
element-wise in a loop over rows.** `toArray()`, accept every typed-array width,
and profile the stages before optimising — measuring showed the parquet decode
was never the problem either time.

### Decision 2 is settled: parquet-wasm stays, no napi-rs escalation

| | |
|---|---|
| RT-bounded XIC, 1.53 GB / 507 M peaks | **178 ms** |
| Native reference for the same query | 105 ms |
| Ratio | **1.7×** — inside the 2–5× estimate, and inside the 350 ms budget |

That closes the escalation documented in `docs/ARCHITECTURE.md`. The native
addon would buy ~70 ms at the cost of a permanent prebuild matrix, and
prefetching adjacent rows hides more than that in the interaction that
actually dominates.

### What the numbers say

```
m/z 1038.45 @ 0.48 min ±0.5 → 28 frames · 3 row groups
                              3.15 M rows decoded / 105k touched · 178 ms
bounded: 3 row groups          unbounded: 484 row groups (all of them)
```

Two separate wins stack here. The **RT bound** picks 3 row groups out of 484.
The **offset table** then narrows 3.15 M decoded rows to the 105k that matter —
worth 373 ms → 178 ms on its own, because testing each decoded row's spectrum
index costs more than decoding it.

Row-group quantisation is the remaining floor: parquet cannot hand back less
than 1,048,576 rows, so a 105k-row answer arrives inside 3.15 M. Nothing to do
about that short of a writer-side change (`docs/ARCHITECTURE.md`, request 3).

### Carried forward

- `verifyOffsets()` still uses the cheap tier and covers ~18 % of rows on the
  large corpus. Now that `PeakReader` exists it should move over and cover 100 %.
- No `.mzpeak` yet for the AGXT runs, so report and drilldown are not joined on
  the same data. Converting one `.d` closes that.
- Metadata index build is 1.8 s on the 1.5 GB file — hyparquet decoding all ~103
  leaves because it cannot project inside a struct. pyarrow does it in 2 ms with
  projection. Moving this facet to the bulk tier too would remove the largest
  single latency in the app.
- Arrow `.get(i)` per row is catastrophic (minutes, not milliseconds). Only ever
  `toArray()`. Worth a lint rule if it recurs.
