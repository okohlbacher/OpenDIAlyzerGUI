# UI design

## The thesis

Every incumbent **materialises the drilldown before it knows the question**.

- **DIA-NN** extracts chromatograms only if you enabled *XICs* before the run,
  by default for library fragments only and within ±10 s of the apex. Widening
  it (`--xic 60`, `--xic-theoretical-fr`) "might require a significant amount of
  disk space" — DIA-NN's own words (`ext/diann/README.md`, *Spectra (XIC
  Viewer)*). Ask a question outside that box and the answer is: re-run the
  analysis.
- **Skyline** imports raw data into `.skyd` cache files sized in tens of GB.
- **Spectronaut** keeps an intermediate of its own.

In every case the set of answerable questions was frozen at analysis time,
around identifications the engine already made.

mzPeak inverts this. It is a STORED (uncompressed) ZIP of Apache Parquet
facets: member offsets are directly addressable, and Parquet row-group
statistics let a reader skip to the row groups covering an **RT** window. A
bounded m/z × RT region is reachable in ~105 ms on a 1.5 GB, 507 M-peak archive
— **measured** — without decompressing the run and without anyone having
anticipated the query.

One honest caveat, because it shapes the design: **m/z is not indexed.** Rows
are ordered `(spectrum, m/z)`, so every Parquet page spans the full m/z axis and
m/z pruning yields nothing. The same query unbounded in RT costs 2.97 s and
reads the entire file. Every raw query the UI issues is therefore RT-bounded —
which the drilldown always can be, from `RT.Start`/`RT.Stop` for an identified
precursor or from predicted RT for *Interrogate*. See `docs/ARCHITECTURE.md`.

> **Every panel is a live query against raw data, not a lookup into a
> pre-computed cache.**

That single property is the reason this project is worth building, and it
dictates the entire design below.

## The three questions

A results UI in this field exists to answer three questions. The field's tools
answer one of them.

| | Question | State of the art | Needs |
|---|---|---|---|
| **1** | *Is this identification real?* | Handled — DIA-NN XIC viewer, Skyline, Spectronaut all show fragment traces | Chromatograms for identified precursors |
| **2** | *Why is my peptide **missing**?* | **Unanswerable.** No engine pre-extracts evidence for candidates it rejected | Raw access at an arbitrary coordinate |
| **3** | *What else is here — what interfered?* | Weakly served; requires arbitrary m/z slicing | Raw access to a neighbourhood |

Question 2 is the one that matters clinically. In immunopeptidomics you often
have a specific peptide of interest — a neoantigen, a validated epitope — and
the finding "not detected" is a claim requiring evidence, not an empty row.
Today the only way to interrogate it is to export the raw file to Skyline and
build a targeted document by hand.

Questions 2 and 3 are free consequences of random access. They are the product.

## Scope, stated as a cut

DIA-NN 2.x already ships a competent statistics environment: differential
abundance with covariates and interaction terms, PCA with metadata regression,
CAMERA pathway enrichment, clustered heatmaps, a methods-text generator and a
JavaScript notebook (`ext/diann/README.md`, *Interpret*). Rebuilding that is
many months to reach parity with something free.

**We do not build statistics.** We build the evidence layer under them, and
export a clean matrix for R, Python, or DIA-NN's own Analyse tab.

`// ponytail: the whole Interpret tab, skipped. Add it when someone demonstrates
// the export path is the bottleneck — not before.`

## Visual identity — derived from OpenMS, not invented

OpenDIAlyzer is built on OpenMS, so it should look like it belongs to OpenMS.
The identity is taken from the mark itself rather than composed alongside it.

The logo (`ext/OpenMS/doc/openms/_static/FinalLogo_Nov2024_Versions-01.svg`) is
a **mass spectrum**: peak sticks woven through the wordmark, filled with a
single horizontal gradient, wordmark in `#231f20`. Two variants exist and differ
only in wordmark colour — `#231f20` for light grounds, `#fff` for dark — so a
single inline SVG using `currentColor` covers both themes.

| Stop | Hex | Role in the application |
|---|---|---|
| 0.00 | `#ffb401` amber | intensity ramp — high |
| 0.22 | `#ff7501` orange | MS1 / precursor traces |
| 0.54 | `#ff03cb` magenta | **y-series fragment ions** |
| 0.77 | `#b503ff` purple | nested-family markers |
| 0.91 | `#3157e9` blue | **b-series fragment ions**; primary interactive accent |
| — | `#231f20` ink | text; the neutral ramp is biased towards it |

**The gradient is not decoration — it is the data encoding.** Reversed
(blue → amber = low → high) it is the intensity ramp on every heat map. Two of
its stops are the fragment-ion series colours. This is defensible rather than
arbitrary: the OpenMS mark is a spectrum, and the application draws spectra.

Semantic colour (good / warning / critical) is kept **separate** from the brand
ramp, so a red does not have to mean both "y-ion" and "failed".

Both themes are first-class. Light is a warm-neutral paper biased toward the
ink; dark is a warm near-black. The blue lightens to `#6b8cf7` on dark and
darkens to `#2544c4` for text on light, so the accent stays legible in both.

### The product lockup

The OpenMS mark is the *ecosystem badge*; the OpenDIAlyzer wordmark is ours.
They sit side by side, divided by a rule, so it is clear which is which.

**`DIA` is picked out in the magenta→purple part of the gradient** — the
meaningful middle of the name, and an echo of how the OpenMS mark colours its
peaks against a dark wordmark.

The **application icon** is a spectrum in the same idiom over that wordmark. It
is deliberately *not* the OpenMS logo cropped: that mark is roughly 4:1 because
its peaks thread through a wordmark, so on a square plate it reads as a thin
band — and lifting it wholesale would claim to *be* OpenMS rather than to
belong to it. The wordmark is legible from about 128 px up, which covers Finder,
the About panel and a large dock; below that the spectrum carries the identity
alone, which is why the sticks stay chunky rather than fine.
`scripts/make-icon.sh` regenerates it.

Attribution: the OpenMS mark is used as an ecosystem badge — OpenMS is BSD-3,
and OpenDIAlyzer links against it as a prerequisite (`README.md`, *Relationship
to other software*). The footer says so explicitly.

`docs/mockup.html` implements all of the above and is the reference.

## Two screens

### Screen 1 — Setup, which becomes Progress

The four questions from `docs/WORKFLOW.md`, then the same surface turns into the
run monitor. Not a wizard, not a modal. One page that changes state.

```
┌────────────────────────────────────────────────────────────────┐
│  ⬒ OpenDIAlyzer                              [session.json ⓘ]  │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   ┌──────────────────────────────────────────────────────┐    │
│   │   Drop .raw / .d / .mzML / .mzpeak files here        │    │
│   │                    or browse                          │    │
│   └──────────────────────────────────────────────────────┘    │
│                                                                │
│   12 runs · Thermo Orbitrap Fusion · 25 windows × 24.0 Th      │
│   158 min gradient · no ion mobility          [details ▾]      │
│                                                                │
│   Sequences   ▸ human_reviewed.fasta            (20 431 seq)   │
│   Peptides    ▸ ⦿ Immunopeptidomics HLA-I         [what? ▾]    │
│   Output      ▸ …/PXD034539/odia-2026-07-23/          [edit]   │
│   Engine      ▸ DIA-NN 2.6.1 Academia  ✓ .NET 8    [change ▾]  │
│                                                                │
│                                        [ Analyse 12 runs ]     │
└────────────────────────────────────────────────────────────────┘
```

The engine line only appears when there is a choice or a problem. DIA-NN is
detected automatically and its runtime dependencies verified **here**, at drop
time — a missing .NET 8 runtime is the single largest support category in the
DIA-NN tracker, and it must never surface as a failure at hour three. If no
engine is found, this row becomes a setup affordance instead of a blocker.

The acquisition summary line is the important detail: it appears the instant
files are dropped, before anything is configured, and it is **read from the
data**. It tells the user we understood their files, and it catches the
wrong-files-dropped mistake in the first second rather than the first hour.

Running state replaces the button with a progress line that expands to per-run
detail. Runs that finish become browsable immediately — **the results screen
opens on partial data and grows.** No modal, no blocked window.

### Screen 2 — the Workbench

Everything else. Three panes, one spine, no tabs.

```
┌─────────────┬──────────────────────────────┬───────────────────────┐
│  SCOPE      │  MATCHES                     │  EVIDENCE             │
│             │                              │                       │
│ ⌕ Cmd-K     │ grain: ⦿Precursors ○Proteins │  SLYNTVATL  2+        │
│             │        ○Runs                 │  ─────────────────    │
│ Runs    12  │ ┌──────────────────────────┐ │   fragment XICs       │
│  ▸ S1_DIA   │ │seq        chg  q     int │ │  ╭──────────────╮     │
│  ▸ S2_DIA   │ │SLYNTVATL  2  1e-4  4.2e6 │ │  │      ╱╲      │     │
│  ▸ …        │ │SLYNTVATLY 2  3e-3  8.1e5 │ │  │    ╱─╳─╲     │     │
│             │ │LYNTVATL   1  0.04  2.0e5 │ │  │  ─╱──╲─╲──   │     │
│ Filters     │ │KLGGALQAK  2  2e-5  9.9e6 │ │  ╰──────────────╯     │
│  q ≤ 0.01 ━ │ │…                         │ │   38.1 ── 38.9 min    │
│  proteotypic│ └──────────────────────────┘ │                       │
│  charge 1-3 │  3 421 of 58 210 rows        │  ▸ MS1 isotopes       │
│             │                              │  ▸ Neighbourhood map  │
│ Preset ▾    │                              │  ▸ Spectrum mirror    │
│ Session ⓘ   │                              │  ▸ Scores             │
└─────────────┴──────────────────────────────┴───────────────────────┘
```

**Left — Scope.** What subset am I looking at. Runs, filters, the FDR slider,
the session card. The FDR slider re-filters instantly because everything down
to 50% q-value was written; it is an exploration axis, not a re-run.

**Centre — Matches.** One virtualised table. The *grain* selector changes what a
row is; it does not change the widget, the filters, or the layout. Selecting a
protein narrows precursors — a breadcrumb, not a new screen. This is where the
QC dashboard lives too: grain = Runs, and the evidence pane shows that run's
metrics. No separate QC screen.

**Right — Evidence.** The selected row's raw data. Progressive:

| Layer | Content | Cost |
|---|---|---|
| **0** — always | Fragment XIC overlay, peak boundaries, q-value, quantity | one range query |
| **1** — one click | MS1 isotope envelope · measured-vs-library mirror plot · **neighbourhood map** (m/z × RT heat of the isolation window) | 2–3 queries |
| **2** — expert | full score vector · ion-mobility heat (Bruker) · **nested-family overlay** · raw peak list at cursor | on demand |

The **neighbourhood map** is the panel no incumbent has, and the one that
answers question 3. It is an m/z × RT heat map of the isolation window around
the match — served from our own cached tile pyramid at low zoom and from exact
peaks when you zoom in. Interference stops being an abstract score and becomes
something you look at.

> The tile pyramid is ours, not the format's. mzPeak has **no pre-binned grid
> facet** — `GRID-FACET-DESIGN.md` is an unimplemented draft, and it proposes
> calibration coefficients rather than binned intensity. See
> `docs/ARCHITECTURE.md`, "Correction 2".

The **nested-family overlay** is the immunopeptidomics-specific panel. HLA
peptides come in families — `SLYNTVATL`, `SLYNTVATLY`, `LYNTVATL` — that share
most fragment ions, which is precisely what breaks the decoy model
(`vault/40-Immunopeptidomics/Why immunopeptidomics breaks DIA tools.md`).
Scoring them independently double-counts shared evidence. The UI must therefore
be able to show them *together*: one chart, sibling peptides overlaid, shared
fragments marked. If the engine arbitrates families jointly, this panel is how a
user checks that the arbitration was right.

## Interrogate — the answer to question 2

A command bar (`Cmd-K`) accepts a peptide sequence, protein, gene, precursor
m/z, or an `m/z @ RT` coordinate.

If the query matches a result, it navigates there. **If it does not**, the UI
does not show an empty table. It offers:

> `SLYNTVATL` — not identified in these runs.
> **[ Interrogate raw data ]**

which computes the precursor m/z and theoretical b/y fragments from the
sequence, extracts the XICs on demand across all runs, and opens the same
evidence panel — with an explicit *no identification* banner. The user sees
whether there is signal at the expected coordinate, whether it co-elutes,
whether something interfered, or whether the peptide genuinely is not there.

This costs one extra query path over what the evidence panel already does. It is
the single feature that no incumbent can add without re-architecting their
storage, and it falls out of mzPeak almost for free.

## Interaction rules

Non-negotiable. Each is a documented failure in an incumbent — see
`docs/COMPETITIVE.md` for the evidence behind every citation.

1. **The window never blocks.** All data access off the UI thread. Every query
   cancellable — scroll away and the in-flight query is abandoned.
2. **Coarse first, then sharp.** Every chart paints from the cached tile
   pyramid immediately and refines to exact peaks. Never a spinner where a
   blurry answer would do.
3. **Selection is shared and bidirectional.** RT range, m/z range and the
   selected match are one piece of state. Zoom one chart, all follow; click a
   point in any plot and the table selects it. Skyline's single-cursor model is
   the thing users rate highest — but it must work **from cold start**, not only
   once every run has been loaded (a live Skyline bug, [rowId=71363](https://skyline.ms/home/support/announcements-thread.view?rowId=71363)).
4. **No hidden filters, ever.** Active filters are a persistent, always-visible
   chip bar with one-click clear, and every export carries the filter set in its
   header. Spectronaut's manual warns *in bold* that its default tree filter is
   easy to miss; DIA-NN's matrices apply an undocumented extra threshold that
   its own maintainer needed three attempts to reproduce.
5. **Evidence class is always visible.** Every identification shows how it was
   obtained — observed in this run / transferred between runs / imputed — as a
   glyph and a filterable column. Defaults that transfer IDs silently put ~16 %
   of a foreign proteome into samples that never contained it.
6. **Cache every candidate peak, not just the winner.** Skyline's `.skyd` keeps
   ~10 candidates plus full peak statistics per chromatogram, which is exactly
   what makes reintegration and imputation feel instant. Storing only the chosen
   peak makes "why this one?" unanswerable.
7. **Manual edits are first-class, marked, queryable and reversible.** A moved
   boundary or a rejected match flags the row, enters the audit log, and can be
   listed ("show me the 47 peaks I touched") and reset. Spectronaut's hand icon
   is right; making the set queryable goes further.
8. **Autosave.** Multi-hour review work is never lost to a crash. Spectronaut
   does not save automatically and says so in the manual.
9. **Show the cost before the commitment.** Predicted memory, disk and wall time
   next to the Analyse button, and a refusal with an explanation when the target
   machine cannot hold the job. Both incumbents publish RAM formulas — on page
   12 of a PDF, where nobody reads them.
10. **Errors say what happened and what to do.** Never a raw status code, never
    a source line number. "OOM during cross-run assembly at run 8,412 of 10,638;
    peak 251 GB of 256 GB; all intermediates intact; resume this stage alone" —
    all of which DIA-NN already has in its log and does not use.
11. **Failure is per-item.** One unreadable file out of 500 loses that file, not
    the batch, and the partial result is browsable.
12. **The log survives the crash.** Append and flush per step; bounded ring
    buffer in the UI so a verbose run cannot exhaust memory.
13. **Everything visible is exportable.** Any chart → SVG/PNG; any table →
    TSV/Parquet, filtered exactly as displayed. Publication figures are the
    actual use case.
14. **Nothing is hidden behind a re-run.** If it can be computed from raw data,
    it is computed now. Corollary: publish which settings are cheap to change
    (FDR, inference, normalisation → recalculate) and which are expensive
    (extraction window, search space → re-run), the way Spectronaut does.
15. **Whatever the CLI can do, the GUI can do.** Skyline's parallel import lives
    only in `SkylineRunner`; DIA-NN's GUI silently caps threads at 40 and the
    advice is to use the command line instead.
16. **No settings the file can answer.** Enforced in Setup, and here too — the
    evidence panel derives its axes from the acquisition rather than asking.
17. **One canonical ordering, shared by every view.** Skyline's Targets tree,
    Results Grid, comparison plots and chromatogram tab strip each keep their
    own replicate order — one data-model defect surfacing as four separate
    complaints and three unimplemented feature requests. Order is document
    state, set once, and sortable by any annotation.
18. **Never encode meaning in colour alone.** Skyline's primary quality
    indicator in the Targets tree is a red/green dot; a request to make it
    shape- or colour-configurable was filed and closed unimplemented. Every
    status carries a shape or a glyph as well as a hue.
19. **No I/O in a hover handler.** Skyline's tree tooltip reads the chromatogram
    cache, which is why it stalls — and one tracker entry is literally a tooltip
    hanging the tree. Hover shows what is already in memory.
20. **No magic ceilings.** Skyline caps chromatogram extraction at 12 files
    whatever the hardware, and its format has hard limits at 2 billion candidate
    peaks and .NET's 2 GB single allocation. Concurrency scales with the machine;
    every on-disk offset is 64-bit from day one.

## Keyboard

The workbench is usable without a mouse, because inspecting 200 candidate
identifications with a mouse is the actual daily task of a curator.

| Key | Action |
|---|---|
| `Cmd-K` | Interrogate / jump |
| `↑ ↓` | Previous / next match — evidence follows immediately |
| `←  →` | Previous / next run, same precursor |
| `Space` | Flag the current match for the review list |
| `[` `]` | Nudge peak boundaries |
| `f` | Fit zoom to peak · `F` fit to run |
| `1…4` | Toggle evidence layers |

`↑`/`↓` with an instantly-following evidence pane is the core loop. It only
works if the drilldown query is genuinely sub-100 ms, which is the performance
requirement that drives `docs/ARCHITECTURE.md`.

## What we deliberately do not build

| Not built | Because |
|---|---|
| Differential abundance, PCA, pathway enrichment | DIA-NN ships it free; export instead |
| Experiment-design metadata editor | SDRF import/export only; editing tables is a spreadsheet's job |
| Pipeline / batch-step builder | The CLI is the pipeline. A GUI pipeline builder is a worse shell script |
| Library editor | Out of scope; libraries are inputs |
| Plugin system | No second implementor exists yet |
| Multi-window / dockable panels | Two screens, three panes. Layout freedom is a support burden, not a feature |

Each of these is a real feature in a competitor and each is a month we do not
spend. The bet is that a tool which answers questions 2 and 3 well beats one
that answers question 1 plus twenty features that already exist elsewhere.
