# The target tree, linked views, and brushing

Design for removing the ×runs × charges redundancy in the results table, and for
the ion-mobility and spectrum viewers that hang off it.

Grounded in a source-level reading of Skyline's `SequenceTree` and its
`SeqNode/*` classes, the Spectronaut 19 manual §3.4.1, and both projects' issue
trackers. Citations are in `docs/COMPETITIVE.md` §C5 and inline below.

## The problem, stated numerically

A DIA-NN report is one row per **(precursor × run)**. On the AGXT cohort:

| | |
|---|---|
| rows | 377,775 |
| distinct stripped sequences | ~40,000 |
| redundancy | **~9×** |

`AAAAAALQAK` appears once per charge per run. The table is honest — that *is*
the report's grain — but it is not navigable.

## What the incumbents do, and why neither is copyable as-is

**Skyline is target-rooted.** Four levels, `Protein → Peptide → Precursor →
Transition`, and **a run is not a level**. It appears as a dropdown above the
tree (in document order, not sortable), one graph window per run, and as text
categories on the x-axis of the replicate-comparison graphs.

**Spectronaut is run-rooted.** `Run → Protein Group → Elution Group →
Precursor → Fragment`. A peptide seen in six runs lives in six disjoint
subtrees, so it does not remove the redundancy — it makes it the skeleton. Its
manual offers "group by precursor window" as a *performance* remedy, which is a
tree restructuring offered to fix responsiveness.

**Skyline's shape is right for us. Its glyph is not.**
`SequenceTree.GetDisplayResultsIndex` resolves the peak-quality icon against
**one** replicate — the selected one, or each peptide's own best. So the tree
answers "is this good in the run I am looking at", never "is this good in all
six". That is the gap.

## The tree

Target-rooted like Skyline, with runs as an **optional leaf level** — collapsed
by default, so the default view is fully de-duplicated.

```
▸ P02768  ALB          47 peptides · 214 precursors   ●●●●●● 6/6
  ▸ YALSQDVCTYR                      3 precursors     ●●●●●● 6/6
    ▸ 863.3640⁺⁺       q 1e-5   RT 26.0              ●●●●●● 6/6
        S08   q 3e-5  RT 26.04  2.1e5
        S23   q 1e-4  RT 26.11  1.8e5
        …
    ▸ 575.9118⁺⁺⁺      q 4e-3   RT 26.0              ●●●○○○ 3/6
  ▸ LVNEVTEFAK                       1 precursor      ●●●●●● 6/6
```

Four levels plus leaves. **Every sequence appears exactly once.**

### The cohort glyph is the differentiator

Each node above run level carries **n/N runs identified**, drawn as N segments —
one per run, each **filled or empty** — plus the fraction as text.

(An earlier draft said "filled, half, or empty". There is no half: a run is
above the current threshold or it is not. The three tones are the *summary*
colour — green at N/N, amber below, matching the cohort call — not a per-segment
state.)

**The exemplar must not undercut the glyph.** A node's exemplar row is the
best-q observation across all runs, which is right for "show me this at its
best" but wrong as the default when the glyph says `3/6`: it pairs a
mediocre-consistency claim with best-case evidence, which is exactly the
"best replicate" dishonesty this document criticises in Skyline's
`GetDisplayResultsIndex`. So selecting a node with `run: undefined` shows the
**cohort view** — all N chromatograms and the presence strip — not the single
best run's pane. Drilling into one run is a deliberate second click.

This is the thing neither tool has. It turns "is this peptide consistent across
my cohort" from a question requiring a second view into a property of the row
you are already looking at.

**Shape and text, never colour alone.** Skyline shipped colour-only red/green
dots and needed until December 2025 to close the accessibility bug
([#941](https://skyline.ms/issues/home/issues/details.view?issueId=941)),
retrofitting a check / triangle / X. We start there.

### What n/N does and does not mean — checked against the data

Two qualifications, both found by reviewing the design against the actual
report rather than by reasoning about it.

**It is a count at the current threshold.** n/N is computed from the *filtered*
set, so moving the FDR slider moves it. That is correct and consistent with the
other grains, but it must be labelled: *"identified in 4 of 6 runs at
q ≤ 0.01"*, never a bare `4/6`.

**Match-between-runs makes it ambiguous, and the report cannot disambiguate it.**
MBR re-searches using an empirical library built from the first pass, and
DIA-NN's report has no column marking which identifications came from that
second pass. With MBR on, `5/6` cannot distinguish five independent detections
from one detection and four transfers. So the session reads MBR state out of
`report.log.txt` and the UI qualifies the glyph when it was on. A two-species
spike-in study found Spectronaut reporting ~16 % of a proteome in samples that
did not contain it, driven by cross-run transfer with nothing in the UI marking
it (`docs/ROADMAP.md`, Phase 3) — this is that failure mode, and the fix is to
say what was measured.

**Protein grouping is not a problem here, verified.** Only 0.1 % of rows list
several accessions, and **0 of 122,713 peptide forms map to more than one
protein group** — DIA-NN assigns each peptide to exactly one group. A single
protein parent per peptide is therefore correct rather than a simplification.

### Counts go on the node, not in a status bar

Skyline puts counts in the bottom-right status bar as
`{selectedPosition}/{total}` per level. That is a fine summary and a poor
navigator: you cannot compare two proteins without selecting each in turn.
Counts belong on the node.

### Node labels

Following Skyline's conventions where they are good, because they are the ones
this field already reads:

| Level | Label |
|---|---|
| Protein | `{accession}  {genes}` — switchable, as Skyline's modal display is |
| Peptide | stripped sequence, modified residues coloured inline |
| Precursor | `{mz:F04}{charge as +/++/+++}` — Skyline's `chargeIndicator`, which both tools use |
| Run | short run name + that run's q, RT, quantity |

Charge as repeated `+` up to 4 then `, +5` is Skyline's `Transition.cs:266-283`
convention and is what users of both tools already recognise.

## Linked views and brushing

### One selection authority

```ts
interface Selection {
  protein?: string;
  peptide?: string;    // MODIFIED sequence — the peptidoform, not stripped
  charge?: number;
  run?: string;        // run identity; undefined = the cohort, not a run
}
```

Two corrections from the plan review, both the same class of bug the code review
already burned us on once:

- **`peptide` is the modified sequence.** An earlier draft said "stripped
  sequence", which cannot name a phosphopeptide — selecting `PEPTIDEK` would
  select both the modified and unmodified form. `src/tree.ts` already keys on
  `Modified.Sequence`; the selection type must agree, or the selection authority
  is coarser than the tree it drives.
- **`run` is an identity, not an index.** Run order is user-sortable by SDRF
  factor, so an index would silently point at a different run when the order
  changes. Order is presentation; identity is what selection holds.

Every view derives from this and nothing holds its own copy. Skyline does the
same with `SelectedPath` + `SelectedResultsIndex`, and it is why its Document
Grid, tree, and graphs stay in step.

**`run: undefined` is meaningful** — it is the cohort view. Selecting a
precursor without a run shows all six chromatograms; selecting a run narrows to
one. Skyline cannot express this, because a replicate is always selected.

### One ordering authority

The clearest defect the research turned up. Skyline has **three independent
replicate orderings**: the tree dropdown (document order, immovable), the graph
windows (`ArrangeGraphsOrder`), and the summary graphs
(`ReplicateOrderEnum` + `OrderByReplicateAnnotation`). So "the 4th bar in Peak
Areas" and "the 4th entry in the dropdown" are routinely different runs.

> **One run order, set once, obeyed by the tree, the cohort strip, the small
> multiples, and every axis.** Sortable by name, acquisition time, or any SDRF
> factor once Phase 3 lands.

### Brushing, both directions

Spectronaut's best idea, which Skyline lacks: **the cross-run view is also a
navigator.** Its XIC-alignment grid titles are click-to-navigate, and its
Cross-Run RT Accuracy bars jump to the clicked run.

So: clicking any run in the cohort strip, any small-multiple, or any point in a
replicate plot **selects that run** and narrows every other view. Hovering
highlights the corresponding element everywhere without changing selection.

### The update loop, copied verbatim

Skyline's `UpdateGraphPanes` is worth stealing exactly
(`SkylineGraphs.cs:843-889`):

1. coalesce updates in a **100 ms** window — holding an arrow key through the
   tree never repaints a chart;
2. then repaint **one pane per event-loop turn**, so a refresh stays
   interruptible.

We already debounce evidence extraction; this generalises it to every pane.

## The two new viewers

### Ion mobility

Skyline's model, which is sound: **not a separate window but a mode of the
spectrum view** (`GraphFullScan.CreateIonMobilityHeatmap`).

- heat map, **x = m/z, y = 1/K0, colour = intensity**
- a **mobilogram** pane to its left, x = intensity **reversed** so zero touches
  the heatmap, y-scale copied pixel-for-pixel so rows line up
  (`CopyYAxisFromHeatmap`)
- the active IM filter window drawn as a translucent band

Two things to do better:

1. **Draw the extraction window as an editable band.** Spectronaut allows
   reintegration in the mobility dimension and notes the RT XIC changes as a
   result. Skyline has no equivalent — its IM window comes from settings.
2. **Never resolve IM columns per row.** Skyline
   [#1009](https://skyline.ms/issues/home/issues/details.view?issueId=1009) was
   exactly that: per-row column detection in the library reader, fixed by
   caching. Our mobility column is already a typed array from the peak facet.

### Spectrum

A mirror plot: observed above, library or predicted below, inverted.

- annotate by ion series with the palette already in use — b blue, y magenta
- label only ions passing the current series/charge/loss filter, as Skyline does
- the fragment selected in the tree drawn in the accent colour
- rescale the mirror so its max matches the main plot's

We have a real advantage here: `--export-quant` gives the engine's own fragments
with measured quantity and score, so the mirror is *measured versus measured*,
not measured versus theoretical.

## Scale

| | Skyline | Spectronaut | Us |
|---|---|---|---|
| hard cap | 200,000 peptides, 5 M transitions (`SrmDocument.cs:276`) | ~0.5 KB RAM per precursor per run | none — the tree is virtualised over the same index arrays as the table |
| tree | stock WinForms `TreeView`, one node object per row | vendor concedes slowness; suggests regrouping as a fix | flattened to a visible-row list; only expanded nodes exist |

The tree must virtualise like the table already does: expansion state is a set
of open paths, the visible rows are computed from it, and only the window is
rendered. Anything else re-creates Spectronaut's Box 11.

## What we are deliberately not doing

| | Why |
|---|---|
| Transitions as a tree level | Fragments belong in the spectrum and chromatogram views, not as 6–12 more rows per precursor. Skyline needs them because its document *is* the method |
| A run-rooted mode | It is the redundancy, restructured |
| Per-view ordering settings | The defect above, three times over |
| Counts in a status bar | Not comparable across rows |


## External review — what it changed

Reviewed adversarially by an external model with the brief "find what makes a
scientist draw a wrong conclusion". 28 findings, 4 critical. The ones that
changed code:

| | Finding | Fix |
|---|---|---|
| **critical** | "No signal — absent, not merely unscored" is unsupportable. Absence of signal above an uncalibrated extraction's sensitivity is not absence of analyte | The panel now reports extraction counts and explicitly disclaims an identification call |
| **critical** | Interrogate matched on the *stripped* sequence, so it would extract for a phosphopeptide and report on its unmodified form | Keyed on `Modified.Sequence`, as the tree already was |
| **critical** | "N of 6 co-elute → consistent with the peptide" is not a defensible test; the thresholds are uncalibrated | Wording removed; `coelution()` documents that its thresholds carry no error rate |
| serious | Protein "Precursors" counted precursor×**run** rows — a 3.8× overstatement on six runs (268,166 reported for 70,755 real) | Distinct precursors counted; row count kept separately as `observations` |
| serious | Fallback protein quantity summed across runs *and* charge states, conflating abundance with run count and missingness | Removed. Shows the engine's MaxLFQ or nothing, with the reason |
| serious | The tree's duplicate-row "keep best" compared q against `prev.seen`, which is always 1 — so the *last* row won, not the best | Compares against the previous row's q-value |
| serious | A requested filter whose column is absent silently became a no-op — "hide decoys" could quietly keep them | Inert filters are recorded so the UI can say the filter did nothing |
| minor | `median()` returned the upper middle value for even counts, shifting every run-QC number | Conventional median |

Since addressed: ion-mobility filtering in XIC extraction (`imCenter`/
`imTolerance` in `extractXic`), and the fragment-matching tolerance, which
now derives per-run from `report.stats.tsv`'s measured MS2 accuracy instead
of a flat 20 ppm (`src/stats.ts`).

Still open from that review: heat maps not comparable across selections,
and the top-400 spectrum truncation.
