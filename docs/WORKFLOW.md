# The minimal DIA workflow

Target: a user with Thermo `.raw` or Bruker `.d` files gets a trustworthy result
without reading a manual, and an expert can still reach every knob.

## The baseline we are cutting from

DIA-NN's GUI exposes ~60 named settings across seven panels (extracted from
`ext/diann/README.md` L792–988): *Threads, Log level, Temp dir, Reuse .quant,
FDR, Library, FASTA, Contaminants, Reannotate, Protease, Misses, Semi, Var mods,
Max var mods, Peptide length range, Precursor charge range, Precursor m/z range,
Fragment m/z range, MS1 accuracy, MS2 accuracy, Scan window, Calibration
accuracy, Calibration library, Unrelated runs, MBR, Protein inference,
Proteotypicity, Quantification strategy, Cross-run normalisation, Machine
learning, Scoring (Peptidoforms/Proteoforms), Speed: RT/IM filtering, Speed:
peak filtering, Mode, Knowledge base, IDs profiling, XICs, Matrices, PDF,
Additional options, …* — plus a free-text **Additional options** box that is the
only route to roughly 200 documented command-line flags.

Two structural problems with that surface, independent of any user complaint:

1. **It asks for things the file already knows.** Precursor m/z range, fragment
   m/z range, and the scan window are all determined by the acquisition method
   that produced the file. `src/odia_info.cpp` in the engine repo already reads
   window layout, cycle time, RT range and IM presence straight out of the data.
   Anything measurable is a bug when it is a question.
2. **It asks for things it should measure.** MS1/MS2 mass accuracy and the
   calibration accuracy are properties of the instrument on the day. DIA-NN can
   already optimise them (setting them to 0), but the manual then warns that
   auto-optimisation breaks `.quant` reuse — so users are pushed to fix values
   they have no principled way to choose.

## The four questions

Everything else is derived, measured, or preset.

| # | Question | UI | Why it cannot be derived |
|---|---|---|---|
| 1 | **Which runs?** | Drop zone. `.raw`, `.d`, `.mzML`, `.mzpeak` | It is the input |
| 2 | **Which sequences?** | One file picker: FASTA *or* spectral library. The type is detected, not asked | It is the input |
| 3 | **What kind of peptides?** | Preset chooser (below) | Encodes a biological claim about the sample that no file contains |
| 4 | **Where does output go?** | Path, pre-filled next to the raw files | Trivial, but must be visible — silent output locations are a real support cost |

Nothing else appears on the first screen. No thread count, no mass accuracy, no
m/z ranges, no scan window, no FDR field.

### A fifth question, asked once and then never again

**Which engine?** Only if more than one is installed. DIA-NN is detected
automatically; if it is the only engine present the question does not appear at
all, and if it is missing the drop zone offers setup instead of failing. The
chosen engine, its version and its edition go into the session record — see
`docs/DIANN-COMPAT.md`.

### FDR is not a setting

DIA-NN's FDR field sets the filter applied when writing the report — get it
wrong and you reprocess. We write everything down to 50% precursor q-value
always, and make the threshold a **slider in the results view** that re-filters
instantly. FDR becomes an exploration axis rather than a commitment made before
the run.

`// ponytail: one write policy, no setting. Costs a few % more disk; removes an
// entire class of "I have to re-run it" support tickets.`

## The presets

A preset is a named bundle of the parameters that are genuinely biological.
Choosing one is the only expert judgement the default path requires.

| Preset | Digest | Length | Charge | Notes |
|---|---|---|---|---|
| **Tryptic proteome** | Trypsin/P, ≤1 missed | 7–30 | 2–4 | The 90% case |
| **Immunopeptidomics HLA-I** | Non-specific | 8–12 | **1–3** | Charge 1 included — the usual silent failure when people run HLA data through tryptic defaults |
| **Immunopeptidomics HLA-II** | Non-specific | 13–25 | 2–4 | |
| **PTM / phospho** | Trypsin/P, ≤2 missed | 7–30 | 2–4 | Peptidoform scoring on |
| **Custom** | — | — | — | Unlocks the full parameter tree |

The preset panel shows its contents as an expandable list, always, without
being asked. A user must be able to see what a preset did without changing
anything. Presets are files, so a lab can add its own and share it.

## What gets measured instead of asked

| Parameter | Source |
|---|---|
| Isolation window layout, count, width, overlap | Read from the file (`odia-info` does this today) |
| Cycle time, points per peak, scan window | Derived from measured cycle time and fitted FWHM |
| RT range, gradient length | Read from the file |
| Ion mobility present? 1/K0 range | Read from the file — Bruker `.d` yes, most Thermo no |
| MS1 / MS2 mass accuracy | Measured in a calibration pass over a subset of scans, then **fixed and recorded** |
| Instrument class (Orbitrap / Astral / timsTOF / TOF) | Read from vendor metadata |
| Thread count per stage | Chosen per stage by the engine, never inherited from core count |

That last row is not a convenience. Measured on the engine side
(`vault/50-Benchmarks/Measured baseline PXD034539.md`): mzML loading at 224
threads was **2× slower** than single-threaded and burned 297× the CPU. A
thread slider is a loaded gun pointed at the user's own throughput. The GUI
shows the thread count the engine chose per stage; it does not offer to change
it outside Custom.

## Vendor specifics, handled not exposed

| | Thermo `.raw` | Bruker `.d` |
|---|---|---|
| Reader | mzPeakConverter (needs .NET 8 runtime) | mzPeakConverter TDF reader, no runtime dep |
| Ion mobility | usually none | **diaPASEF — always** |
| Typical size | 1–3 GB | 5–50 GB |
| Extra UI | none | IM axis appears in the drilldown; IM tolerance in the preset |

Detection is by path (`.d` directory vs `.raw` file) plus vendor metadata. The
user is never asked which instrument they used. **Missing runtime dependencies
are diagnosed at drop time, not at hour three of a run** — dropping a `.raw`
with no .NET runtime present must produce an actionable message immediately,
with the install command, not a failure deep in the pipeline.

## Conversion is not a step the user sees

mzPeak is our working format because it is what makes the drilldown fast
(`docs/ARCHITECTURE.md`). But "convert your files first" is a step users skip,
get wrong, or blame us for. So:

- Dropping vendor files starts conversion immediately, in the background, with
  a progress bar per file.
- Converted `.mzpeak` files are written next to the source by default and
  **reused on subsequent sessions** — checked by content hash, not filename.
- Dropping an existing `.mzpeak` skips straight to analysis.
- Conversion failures are per-file and non-fatal. Nine files converting and one
  failing means nine files analysed and one clearly flagged, not a dead run.

## The run itself

One progress surface, three levels of depth, no modality:

1. **A single line**: what stage, which run, how far, estimated finish.
2. **Expandable**: per-stage timings and per-run status for the whole
   experiment; failed runs marked and re-runnable individually.
3. **The log**: full text, searchable, always saved next to the output.

The window stays interactive throughout. Completed runs become browsable while
later ones are still processing — the results view opens on partial data and
grows.

That is not a presentation trick. Both engines are driven as
**calibrate → per-run → aggregate**, so a finished run really is finished and
really is inspectable. For DIA-NN this is built from its own documented
incremental-processing flags rather than from anything we add to it
(`docs/DIANN-COMPAT.md`), and it is what gives per-file isolation, a real
checkpoint, and order-independent results.

## Provenance, automatic

Every output folder gets a `session.json`: exact engine version and build,
every parameter with its value *and where it came from* (preset / measured /
user override), input file hashes, the preset name and version, timings, and
the host. The results view renders it as a read-only card. Reproducing an
analysis is opening that file, not remembering what you clicked.

Reproducibility is not an expert feature here. In immunopeptidomics the
question "which settings produced this patient's neoantigen list?" is a
regulatory question, not a curiosity.
