# Visualization plan — IMS-DIA representations

Derived from the July 2026 deep-research survey of published SWATH/diaPASEF
figures (25 sources, 18 claims confirmed by 3-vote adversarial review, 7
refuted). This plan implements the representations that survived verification,
and marks clearly which ones have **no published precedent** and are therefore
speculative.

Read `docs/UI-DESIGN.md` first — this extends its thesis, it does not replace it.

## What the survey established

Every 2D figure collapses at least two of {RT, precursor m/z, fragment m/z,
1/K0, intensity}. The published field uses exactly three reduction moves — fix
precursor m/z to a window, filter on it, or facet per fragment — and **no
published figure puts precursor m/z and fragment m/z on the same axes.**

The single most transferable result: AlphaViz's per-fragment RT × 1/K0
small-multiple grid (bioRxiv 2022.07.12.499676 Fig. 3C/3D) is the only
representation published as **absence evidence**, twice — refuting a DIA-NN ID
scored 0.91 by showing no fragments in the expected box, and exposing a
precursor-only peak behind scores of 0.92/0.94. Every tile is exactly an
RT-bounded m/z × mobility region query, which is the query this codebase
already serves.

## Gap analysis against what we ship today

| Representation | Status |
|---|---|
| m/z × 1/K0 heatmap + mobilogram + apex spectrum | **Ships** — `heatmap()`, `evidence:frame`, canvas in `renderer.js` |
| Fragment XIC overlay (transition group) | **Ships** — `extractXic()` |
| Per-fragment RT × 1/K0 small-multiple grid | **Missing** — the flagship gap |
| Expected-coordinate box overlay | **Missing** — and absence is unreadable without it |
| Cycle-sampling markers (points across the peak) | **Data exists, never drawn** — `Xic.rt` is one point per frame |
| RT × fragment-m/z MS2 map (ID-free) | **Missing** |
| Run-level ID-free QC | **Missing** |
| Fragment × fragment co-elution matrix | **Missing — and novel, no published precedent** |

## Where this gets built, and why not in Rust

Build in the existing TypeScript stack (`src/peaks.ts` + `app/renderer.js`),
**not** in the Tauri port.

The engine these views need — mobility-aware, RT-bounded, random-access — exists
today only in TypeScript. Reproducing it in Rust is Tauri Phase 2, weeks out.
Meanwhile the *drawing* code is framework-agnostic: it paints a canvas from a
binned grid, and behaves identically under Electron's webview and Tauri's. It
moves across with the rest of the renderer in Tauri Phase 3 at no extra cost.
The only per-shell code is the one-line transport (`ipcRenderer.invoke` vs
`invoke`), which the planned `window.api` adapter shim already absorbs.

Building visuals in Rust first would mean porting an engine before knowing which
views are worth keeping. Wrong order.

## Architecture rule: separate the math from the paint

Every view splits in two, and the split is what makes visualization testable:

- **Math** — a pure function in `src/peaks.ts` that turns raw peaks into a
  fixed-size binned grid or matrix. Deterministic, no DOM, unit-testable against
  synthetic ground truth.
- **Paint** — a function in `app/renderer.js` that turns that grid into canvas
  marks. Thin, no data logic, testable for structural invariants.

Binning stays server-side, as `heatmap()` already does: a diaPASEF frame is
~200,000 peaks and shipping those to the UI to bin would dominate the cost.

---

# Phases

## Phase V1 — Engine primitives (no UI)

Two new pure functions in `src/peaks.ts`, plus tests. Nothing renders yet; this
is the substrate everything else needs.

**`rtMobilityMap(...)` → `RtMobilityMap | null`**
Bins one m/z window's peaks over (RT, 1/K0) across a frame range. This is the
per-fragment tile. Differs from `heatmap()` in exactly one way — the x axis is
retention time rather than m/z — but that difference is the whole flagship view.
Returns `null` when the archive carries no mobility, mirroring `heatmap()`.

**`correlationMatrix(traces)` → `{ r: Float32Array; n: number }`**
Pairwise Pearson correlation over XIC traces, row-major `n × n`. Substrate for
the novel co-elution matrix. Pure, trivially testable, no I/O.

Deliberately **not** extending `coelution()`: its docstring already warns its
thresholds are uncalibrated. A correlation matrix reports numbers and lets the
reader judge; it must not acquire a verdict.

### Adversarial failure modes to test, not assume

| Risk | Test |
|---|---|
| Archive has no mobility (Q-TOF/SWATH) | Returns `null`, never throws or renders a lying empty grid |
| Constant trace (zero variance) | Pearson is undefined — must yield 0, not `NaN`, and never poison the matrix |
| Single frame / single point | No divide-by-zero; degenerate range handled |
| All-zero intensity window | Valid empty grid, `maxIntensity === 0`, still renderable |
| Log scaling invents structure | Assert a linear→log round-trip on known input; keep `maxIntensity` so the UI can state absolute numbers |
| Bin off-by-one at range edges | Peak at exactly `rtMax`/`imHi` lands in the last bin, not out of bounds |
| Ground truth | Synthetic peak injected at known (RT, 1/K0) apexes in the **correct bin** — the end-to-end check that matters |

## Phase V2 — The evidence grid *(flagship)*

The per-fragment RT × 1/K0 small-multiple grid, with the expected box.

- **IPC** `evidence:grid` → one precursor tile + N fragment tiles + the expected
  (RT, 1/K0) box + per-tile occupancy inside that box.
- **Paint** a small-multiple canvas grid; every tile draws the expected box as a
  **stroked outline**, always, including when the tile is empty.

**The non-negotiable detail.** In AlphaViz Fig. 3D the refuting tiles are *not
blank* — they carry scattered signal that simply isn't at the expected
coordinates. Omit the box and absence reads as noise. Skyline draws its
extraction windows for the same reason, but its own tutorial calls the pale
violet fill "very light", and it vanishes exactly where points are dense. So:
**strokes or hatching, never low-alpha fills.** A test asserts the box is
emitted for a tile with zero points.

### Adversarial failure modes

| Risk | Mitigation |
|---|---|
| **N+1 query cost.** The grid is N+1 region reads, not one. The survey *refuted* the usual citation for interactive random-access latency, so we have no published support for this being fast. | Benchmark gate before the view ships. Budget asserted in tests. Share one frame-range decode across tiles where possible. |
| Empty grid reads as "no data" vs "no signal" | Distinct rendering for *archive missing* / *no frames covered* / *frames read, zero intensity* |
| Per-tile autoscaling makes a noise tile look identical to a real peak | Shared intensity scale across tiles by default, with the absolute max stated |
| `imTolerance` default ±0.05 is ~a full mobility peak width (survey caveat) | Expose it; test that tightening it changes occupancy as expected |
| Tile count explodes the payload | Cap fragments; grid stays a fixed-size `Float32Array` per tile |

## Phase V3 — Cycle sampling *(cheap, high value)*

`Xic.rt` already holds one point per frame — i.e. per DIA cycle. Today it is
drawn as a smooth line, which silently implies continuous sampling.

Draw the actual sample points as markers on the XIC, and report
points-across-the-peak. This addresses the survey's **Gap B** (no published
figure specifically encodes cycle-by-cycle sampling) at near-zero cost, because
the data is already in hand.

Adversarial: a line through 5 points and a line through 40 look equally
confident at a glance. Markers must be visible enough to undercut that, and
under-sampling should be stated as a number, not left to the eye.

## Phase V4 — ID-free views

**RT × fragment-m/z MS2 map** (after Gillet 2012 Fig. 1B) and **run-level QC**
(after AlphaTims Fig. 3): TIC vs RT, plus RT × 1/K0, with no peptide named.

Run QC earns its place by separating two failures that look identical from
inside a peptide-centric viewer: *my peptide is missing* vs *the instrument
broke at minute 12*.

**The trap, from the survey:** acquisition-scheme texture is a **per-frame**
property. Summing MS2 over an RT range renders the union of visited isolation
windows and destroys the diagnostic. So these render single frames or facet by
isolation window — never a blind sum. A test asserts a summed map and a
per-frame map differ on diaPASEF input.

## Phase V5 — Co-elution matrix *(novel — unvalidated)*

Fragment × fragment correlation over an RT-bounded window, filling the survey's
**Gap A** (no published figure shows pseudo-spectrum internal structure). A
coherent block is a peptide; an off-diagonal block is an interferent with its
own profile.

Zero published precedent means novel *and* unproven. Ships behind a flag,
labelled as experimental in the UI, and validated against a known chimeric case
before it earns permanent space. If it cannot be shown to separate a real
interference case, it gets deleted rather than kept for looking clever.

---

## Testing strategy

The existing suite is `node --test` over `test/**/*.test.ts`. Visualization adds
four layers:

1. **Pure math, synthetic ground truth.** A peak injected at a known (RT, 1/K0,
   m/z) must apex in the predicted bin. Correlation of a trace with itself is 1;
   with its negation, −1; with a constant, 0 (not `NaN`).
2. **Invariants on real data.** Grid cell sum equals total in-window intensity;
   mobilogram equals the row marginal; matrix is symmetric with unit diagonal.
   Run against the local timsTOF archives in `mzpeak-example-data/ims-examples/`.
3. **Paint purity — the NaN sweep.** Draw functions run against a stubbed canvas
   that records every call; assert no coordinate is `NaN`/`undefined` and that
   mark counts match the input grid. This catches the failure that renders a
   blank panel with no error, which is the characteristic way visualization code
   fails silently.
4. **Performance budgets.** Explicit ms budgets per view, in the spirit of the
   existing XIC budget test. The grid's N+1 cost is the one to watch.

Budgets are asserted but must be tuned to the machine — the existing suite
already shows timing tests flaking under load, so they are written to fail loudly
and be re-tuned, not silently widened.

## Provenance

Full survey, figures and citations:
`docs/research/ims-dia-visualization.md` (report artifact). Key sources —
Gillet 2012 *MCP* 11(6):O111.016717 Fig. 1B/6; Voytik 2022 *bioRxiv*
2022.07.12.499676 Fig. 3C/3D, 6B; Willems 2021 *MCP* 20:100149 Fig. 3/4;
Skowronek 2023 *MCP* 22(2):100489 Fig. 2A; Skyline IMS tutorials.

Caveat carried forward: AlphaViz is an unreviewed preprint by the tool's own
developers. It is cited here for prior art and figure description only, never
for a superiority claim.
