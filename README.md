# OpenDIAlyzer GUI

Cross-platform workbench for DIA proteomics. **Sets up, runs and inspects
DIA-NN**, and drills into the raw data behind any identification on demand.
[OpenDIAlyzer](../OpenDIAlyzer) becomes a second engine behind the same
interface when it is ready.

> **Status: design.** No code yet beyond a working interaction mockup. The
> architecture is specified and adversarially grounded before implementation,
> the same way the engine project was.

**The GUI does not wait for the engine.** OpenDIAlyzer is early-stage with an
unsolved research problem at its core, so the workbench is fully usable with
DIA-NN as the only engine installed — it detects it, verifies its runtime
dependencies, builds and previews the invocation, runs it in a resumable
per-run plan, and reads the results. See
[docs/DIANN-COMPAT.md](docs/DIANN-COMPAT.md).

## The thesis

Every incumbent **materialises the drilldown before it knows the question.**

DIA-NN extracts chromatograms only if you enabled *XICs* before the run, by
default for library fragments within ±10 s of an apex, and only for precursors
it identified. Skyline imports raw data into `.skyd` caches measured in tens of
GB. Spectronaut keeps an `.sne`. In each case the set of answerable questions
was frozen at analysis time, around the identifications the engine already made.

mzPeak is a STORED ZIP of Apache Parquet facets: member offsets are directly
addressable, and Parquet row-group statistics let a reader seek to an **RT**
region in milliseconds. (m/z is *not* indexed — measured, see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); every query is therefore
RT-bounded, which the drilldown always can be.) So:

> **Every panel is a live byte-range read into raw data, not a lookup into a
> pre-computed cache.**

Which makes three questions answerable instead of one:

| | Question | State of the art |
|---|---|---|
| 1 | *Is this identification real?* | Solved by everyone |
| 2 | *Why is my peptide **missing**?* | **Unanswerable** — nobody extracts evidence for a rejected candidate |
| 3 | *What else is here — what interfered?* | Weakly served; needs arbitrary m/z slicing |

Question 2 is the clinical one. In immunopeptidomics you often have a specific
peptide of interest — a neoantigen, a validated epitope — and "not detected" is
a claim that needs evidence, not an empty row.

And one more, which the research made unavoidable: **the drilldown layer of
every incumbent is Windows-only.** Spectronaut's Linux build is command-line
only and you must move the `.sne` back to Windows to look at it; Skyline is
Windows-only by policy; DIA-NN's 2.5/2.6 Report Window is .NET 8 and
[has not launched under Wine since December 2025](https://github.com/vdemichev/DiaNN/issues/1815).
Every Linux, HPC, cloud and macOS user is locked out. Cross-platform is the
largest uncontested opening in this market, not a convenience.

## Running it

```bash
npm install
npm run app                      # open empty, then use "Open report…"
npm run app -- <report.parquet>  # open a report directly
npm run app -- <directory>       # open the report found in that directory
```

Matching `.mzpeak` archives are paired automatically by run identity — put them
beside the report, or in a `raw/` or `mzpeak/` folder next to it. A report opens
fine without them; the evidence pane says what is missing instead of failing.

## Documents

| | |
|---|---|
| [docs/mockup.html](docs/mockup.html) | **Start here.** Working interaction mockup — grain switching, FDR slider, the Interrogate flow, the provenance panel. Open it in a browser |
| [docs/UI-DESIGN.md](docs/UI-DESIGN.md) | Two screens, three panes, the drilldown layers, visual identity, 21 interaction rules |
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | The minimal DIA workflow — four questions, Thermo and Bruker handled not exposed |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Electron + TS 7.0, the `RangeReader` interface, the two-tier Parquet stack, and what mzPeak measurably does and does not index |
| [docs/DIANN-COMPAT.md](docs/DIANN-COMPAT.md) | **Running** DIA-NN — setup, flag mapping, the calibrate→per-run→aggregate plan — and **reading** it: `report.parquet` alone must produce a navigable session |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases — provenance, SDRF/ISA, repository submission, cluster and cloud |
| [docs/COMPETITIVE.md](docs/COMPETITIVE.md) | The evidence. Source-provable findings, 1,290 DIA-NN issues, the Spectronaut manual, and 837 Skyline support threads |

## Design in one page

**Four questions on setup.** Which runs, which sequences, what kind of peptides,
where does output go. Everything else is measured from the file or comes from a
preset. DIA-NN's GUI has ~47 settable controls, ~12 of which do nothing on a
default run with no indication.

**Two screens.** Setup, which becomes the run monitor. Then the workbench:
scope / matches / evidence, with a grain selector rather than tabs. QC is not a
separate screen — it is the Runs grain.

**FDR is not a setting.** Everything is written down to 50 % q-value; the
threshold is a slider that re-filters instantly. An exploration axis, not a
commitment made before the run.

**Interrogate.** `⌘K`, type a peptide. If it is in the results, go there. If it
is not, extract its theoretical fragments from raw data anyway and show what is
actually at that coordinate.

**No statistics.** DIA-NN 2.6 ships differential abundance, PCA and pathway
enrichment for free. We export a clean matrix and do not compete. The gap worth
attacking is the raw evidence layer underneath.

## Relationship to the other projects

- **[OpenDIAlyzer](../OpenDIAlyzer)** — the engine. Separate repository,
  separate lifecycle. **This GUI works entirely without it**, driving DIA-NN.
- **DIA-NN** — detected and invoked, never redistributed. The user installs it
  under their own agreement with the vendor.
- **[mzPeakConverter](../mzPeakConverter)** — vendor formats → `.mzpeak`.
  Shipped as a spawned sidecar, not linked.
- **OpenMS** — the ecosystem this belongs to. The visual identity is derived
  from the OpenMS logo's own spectral gradient; see
  [docs/UI-DESIGN.md](docs/UI-DESIGN.md). BSD-3.

## Tests

`npm test` runs everything. Tests that need real mass-spectrometry data skip
unless you point them at it: copy `test/local-data.example.json` to
`test/local-data.json` and fill in the paths, or set `ODIA_TEST_<KEY>`
environment variables with the same keys. `test/local-data.json` is ignored by
git on purpose — data file names can identify unpublished studies and their
samples, so they are never committed.

## Licence

BSD-3-Clause, matching OpenDIAlyzer. See [LICENSE](LICENSE).
