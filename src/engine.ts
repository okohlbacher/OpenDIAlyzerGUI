/**
 * Finding, checking and driving a search engine.
 *
 * Specified in `docs/DIANN-COMPAT.md` and validated by hand against DIA-NN
 * 2.6.1 on a cluster before any of it was written here. Two properties carry
 * the design:
 *
 * **Nothing runs until it has been checked.** "Install the right runtime" is
 * the single largest support category in DIA-NN's tracker — 77 maintainer
 * replies — and every one of those is a failure that could have been a message
 * before the run started rather than an exit code hours into it.
 *
 * **`plan()` returns stages without executing anything.** The invocation is
 * previewable before launch, hashable into a provenance record, and identical
 * whether it runs here or on a cluster. DIA-NN's own GUI prints its command
 * line only *after* starting the process.
 */
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, basename, dirname } from "node:path";

const run = promisify(execFile);

export type EngineId = "diann" | "odia";

export interface Install {
  id: EngineId;
  /** Absolute path to the executable. */
  path: string;
  /** e.g. "2.6.1" */
  version: string;
  /** "Academia" | "Enterprise" | "" — the limits of Academia are not public. */
  edition: string;
  /** Reported by the binary; DIA-NN documents that prediction varies with it. */
  logicalCores: number | null;
  raw: string;
}

export interface Requirement {
  name: string;
  ok: boolean;
  /** What this gates — stated in terms of the user's data, not ours. */
  needed: string;
  detail: string;
  /** A command the user can run, when there is one. */
  remedy?: string;
}

/** Where DIA-NN is normally found, per platform. */
export function searchPaths(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (process.platform === "win32") {
    return [
      "C:\\DIA-NN",
      "C:\\Program Files\\DIA-NN",
      join(home, "DIA-NN"),
    ];
  }
  return [
    join(home, "diann"),
    join(home, "DIA-NN"),
    "/opt/diann",
    "/usr/local/bin",
    "/usr/local/diann",
  ];
}

const EXE = process.platform === "win32" ? "diann.exe" : "diann-linux";

/**
 * Locates DIA-NN installations.
 *
 * Several versions side by side is the expected arrangement, not an error —
 * DIA-NN's own FAQ recommends keeping old ones so past analyses stay
 * reproducible, and `.quant` files are not portable between versions.
 */
export async function detect(extraPaths: readonly string[] = []): Promise<Install[]> {
  const candidates = new Set<string>();
  for (const dir of [...extraPaths, ...searchPaths()]) {
    candidates.add(join(dir, EXE));
    candidates.add(dir); // the user may point straight at the binary
  }
  for (const p of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (p) candidates.add(join(p, EXE));
  }

  const found: Install[] = [];
  for (const path of candidates) {
    try {
      const st = await stat(path);
      if (!st.isFile()) continue;
      await access(path, constants.X_OK);
    } catch {
      continue;
    }
    const info = await identify(path);
    if (info) found.push(info);
  }
  return found;
}

/**
 * Reads version and edition from the binary's own banner.
 *
 * ```
 * DIA-NN 2.6.1 Academia  (Data-Independent Acquisition by Neural Networks)
 * Compiled on Jun 30 2026 14:41:29
 * Logical CPU cores: 224
 * ```
 */
export async function identify(path: string): Promise<Install | null> {
  let out = "";
  try {
    const r = await run(path, [], {
      timeout: 20_000,
      maxBuffer: 1 << 20,
      cwd: dirname(path),
      env: { ...process.env, LD_LIBRARY_PATH: dirname(path) },
    });
    out = r.stdout + r.stderr;
  } catch (e) {
    // Invoked with no arguments DIA-NN prints its banner and exits non-zero.
    const err = e as { stdout?: string; stderr?: string };
    out = (err.stdout ?? "") + (err.stderr ?? "");
    if (!out) return null;
  }
  return parseBanner(out, path);
}

export function parseBanner(out: string, path: string): Install | null {
  const m = /DIA-NN\s+([0-9][0-9.]*)\s*([A-Za-z]*)/.exec(out);
  if (!m) return null;
  const cores = /Logical CPU cores:\s*(\d+)/.exec(out);
  return {
    id: "diann",
    path,
    version: m[1]!,
    edition: m[2] ?? "",
    logicalCores: cores ? Number(cores[1]) : null,
    raw: out.split(/\r?\n/).slice(0, 4).join("\n").trim(),
  };
}

/**
 * Checks what the chosen install needs for the data at hand.
 *
 * Deliberately data-driven: a missing .NET runtime does not matter until a
 * Thermo `.raw` is dropped, and saying so keeps the check honest instead of
 * demanding everything up front.
 */
export async function verify(install: Install, formats: readonly string[]): Promise<Requirement[]> {
  const dir = dirname(install.path);
  const reqs: Requirement[] = [];
  const has = async (f: string) => {
    try { await access(join(dir, f)); return true; } catch { return false; }
  };

  if (formats.includes(".raw")) {
    let ok = false;
    let detail = "not found";
    try {
      const r = await run("dotnet", ["--list-runtimes"], { timeout: 15_000 });
      const versions = [...r.stdout.matchAll(/Microsoft\.NETCore\.App\s+(\d+)\./g)].map((x) => Number(x[1]));
      ok = versions.some((v) => v >= 8);
      detail = ok ? `.NET ${Math.max(...versions)} present` : `found ${versions.join(", ") || "none"}, needs 8+`;
    } catch {
      detail = "dotnet not on PATH";
    }
    reqs.push({
      name: ".NET 8 runtime", ok, detail,
      needed: "reading Thermo .raw",
      remedy: ok ? undefined : "install the .NET 8 runtime from dotnet.microsoft.com",
    });
  }

  if (formats.includes(".d")) {
    const lib = process.platform === "win32" ? "timsdata.dll" : "libtimsdata.so";
    const ok = await has(lib);
    reqs.push({
      name: lib, ok,
      needed: "reading Bruker .d",
      detail: ok ? `present in ${basename(dir)}` : `missing from ${dir}`,
      remedy: ok ? undefined : "reinstall DIA-NN — this ships with it",
    });
  }

  if (formats.includes(".wiff")) {
    const ok = process.platform !== "linux" && await has("Clearcore2.Data.dll");
    reqs.push({
      name: "Sciex Clearcore", ok,
      needed: "reading Sciex .wiff",
      detail: process.platform === "linux"
        ? "not available on native Linux — convert to mzML first"
        : ok ? "present" : "missing from the install directory",
    });
  }
  return reqs;
}

export interface Job {
  runs: string[];
  fasta?: string;
  library?: string;
  outputDir: string;
  preset: PresetId;
  threads: number;
  /** Pinned from a calibration pass. Absent means stage 1 must run first. */
  massAccMs2?: number;
  massAccMs1?: number;
  scanWindow?: number;
}

export type PresetId = "tryptic" | "hla1" | "hla2" | "phospho";

/**
 * A preset is the parameters that encode a biological claim about the sample.
 * Everything else is measured from the data or fixed by policy.
 */
export const PRESETS: Record<PresetId, { label: string; flags: string[]; note: string }> = {
  tryptic: {
    label: "Tryptic proteome",
    note: "The 90 % case.",
    flags: ["--cut", "K*,R*,!*P", "--missed-cleavages", "1", "--min-pep-len", "7",
            "--max-pep-len", "30", "--min-pr-charge", "2", "--max-pr-charge", "4",
            "--met-excision"],
  },
  hla1: {
    label: "Immunopeptidomics HLA-I",
    note: "Non-specific digest, 8–12 residues, charge 1 included — which tryptic defaults exclude, and is the commonest silent failure for HLA data.",
    flags: ["--cut", "**", "--missed-cleavages", "100", "--min-pep-len", "8",
            "--max-pep-len", "12", "--min-pr-charge", "1", "--max-pr-charge", "3"],
  },
  hla2: {
    label: "Immunopeptidomics HLA-II",
    note: "Non-specific digest, 13–25 residues.",
    flags: ["--cut", "**", "--missed-cleavages", "100", "--min-pep-len", "13",
            "--max-pep-len", "25", "--min-pr-charge", "2", "--max-pr-charge", "4"],
  },
  phospho: {
    label: "PTM / phospho",
    note: "Tryptic with phospho as a variable modification, peptidoform scoring on.",
    flags: ["--cut", "K*,R*,!*P", "--missed-cleavages", "2", "--min-pep-len", "7",
            "--max-pep-len", "30", "--min-pr-charge", "2", "--max-pr-charge", "4",
            "--var-mod", "UniMod:21,79.966331,STY", "--var-mods", "1", "--peptidoforms"],
  },
};

export interface Stage {
  id: "calibrate" | "quantify" | "aggregate";
  label: string;
  /** Runs this stage covers. Empty for aggregate, which covers all of them. */
  runs: string[];
  /** The exact config file contents. This *is* the provenance artefact. */
  cfg: string;
  /** argv, always just `--cfg <file>`. */
  argv: string[];
  cfgPath: string;
}

/**
 * Builds the run plan without executing anything.
 *
 * calibrate → per-run → aggregate, using only documented DIA-NN flags. The
 * per-run split is what gives per-file isolation and a real checkpoint: one
 * unreadable file loses that file rather than the batch, and the aggregate
 * stage can be restarted alone on a bigger machine. DIA-NN's own *Incremental
 * processing* section describes this pattern and states its prerequisite —
 * fixed mass accuracies and scan window — which stage 1 exists to satisfy.
 */
export function plan(job: Job): Stage[] {
  const preset = PRESETS[job.preset];
  const out = job.outputDir;
  const common = [
    ...(job.library ? ["--lib", job.library] : []),
    ...(job.fasta ? ["--fasta", job.fasta] : []),
    ...(job.fasta && !job.library ? ["--fasta-search", "--predictor"] : []),
    ...preset.flags,
    // Policy, not preference — see docs/DIANN-COMPAT.md.
    "--qvalue", "0.5",        // write everything; FDR becomes a slider
    "--export-quant",         // the engine's own fragments, into the report
    "--threads", String(job.threads),
    "--verbose", "1",
  ];

  const stages: Stage[] = [];

  /**
   * Renders an argv-style list as a DIA-NN config file.
   *
   * A flag and its value belong on one line — that is how DIA-NN's own
   * generated configs look, and splitting them would leave the parser reading
   * `0.5` as a bare command. Values are left unquoted because `--cfg` takes the
   * rest of the line verbatim, which is also why paths containing `--` are
   * rejected before we get here.
   */
  const cfgFor = (argv: string[]) => {
    const lines: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        lines.push(`${a} ${argv[++i]}`);
      } else {
        lines.push(a);
      }
    }
    return lines.join("\n") + "\n";
  };

  const pinned = job.massAccMs2 !== undefined && job.massAccMs1 !== undefined &&
    job.scanWindow !== undefined;

  if (!pinned) {
    const first = job.runs[0];
    stages.push({
      id: "calibrate",
      label: "Calibrate on one run",
      runs: first ? [first] : [],
      cfgPath: join(out, "stage1-calibrate.cfg"),
      argv: ["--cfg", join(out, "stage1-calibrate.cfg")],
      cfg: cfgFor([
        ...(first ? ["--f", first] : []),
        ...common,
        "--out", join(out, "calibrate", "report.parquet"),
      ]),
    });
  }

  const pin = pinned
    ? ["--mass-acc", String(job.massAccMs2), "--mass-acc-ms1", String(job.massAccMs1),
       "--window", String(job.scanWindow)]
    : [];

  for (const r of job.runs) {
    const name = basename(r).replace(/\.[^.]+$/, "");
    stages.push({
      id: "quantify",
      label: `Quantify ${name}`,
      runs: [r],
      cfgPath: join(out, `stage3-${name}.cfg`),
      argv: ["--cfg", join(out, `stage3-${name}.cfg`)],
      cfg: cfgFor(["--f", r, ...common, ...pin, "--out", join(out, "per-run", `${name}.parquet`)]),
    });
  }

  stages.push({
    id: "aggregate",
    label: `Combine ${job.runs.length} runs`,
    runs: [],
    cfgPath: join(out, "stage4-aggregate.cfg"),
    argv: ["--cfg", join(out, "stage4-aggregate.cfg")],
    cfg: cfgFor([
      ...job.runs.flatMap((r) => ["--f", r]),
      ...common, ...pin,
      "--use-quant",
      "--out", join(out, "report.parquet"),
    ]),
  });
  return stages;
}

/** Optimised values DIA-NN reports during a calibration run. */
export interface Calibration {
  massAccMs2?: number;
  massAccMs1?: number;
  scanWindow?: number;
}

/** Reads the values stage 1 exists to produce out of DIA-NN's log. */
export function parseCalibration(log: string): Calibration {
  const c: Calibration = {};
  const ms2 = /Optimised mass accuracy:\s*([\d.]+)\s*ppm/i.exec(log);
  if (ms2) c.massAccMs2 = Number(ms2[1]);
  // Reported once per run; the median is the sane pin across an experiment.
  const ms1 = [...log.matchAll(/Recommended MS1 mass accuracy setting:\s*([\d.]+)\s*ppm/gi)]
    .map((m) => Number(m[1]));
  if (ms1.length) {
    ms1.sort((a, b) => a - b);
    c.massAccMs1 = ms1[ms1.length >> 1];
  }
  const win = /Scan window radius set to\s*(\d+)/i.exec(log);
  if (win) c.scanWindow = Number(win[1]);
  return c;
}

/** Human text for the exit codes DIA-NN actually produces. */
export function explainExit(code: number, log: string): string {
  const assertion = /ERROR: algorithmic failure: src\/diann\.cpp: (\d+)/.exec(log);
  if (assertion) {
    return "DIA-NN hit an internal assertion (diann.cpp:" + assertion[1] + "). " +
      "Not directly actionable — the log excerpt is what its author will ask for.";
  }
  if (/unrecognised option/i.test(log)) {
    return "DIA-NN rejected a flag, which means part of the configuration was " +
      "silently dropped. Treated as a failure rather than a warning.";
  }
  switch (code >>> 0) {
    case 0xC0000409:
      return "DIA-NN crashed (stack corruption). Almost always out of memory — " +
        "check the free RAM against the library size.";
    case 0xC0000005:
      return "DIA-NN crashed (access violation). Usually out of memory, sometimes " +
        "an unreadable input file.";
    case 137:
      return "Killed by the operating system — out of memory.";
    default:
      return `DIA-NN exited with code ${code}.`;
  }
}

/**
 * Rough peak memory, from DIA-NN's own documented rate of ~0.5 GB per million
 * library precursors. Crude, but it turns "died at hour twelve" into a warning
 * before the run starts.
 */
export function estimateMemoryGb(libraryPrecursors: number, runs: number, mbr: boolean): number {
  const lib = (libraryPrecursors / 1e6) * 0.5;
  // MBR holds per-run quantities in memory during the second pass.
  const cross = mbr ? runs * 0.05 : 0;
  return Math.max(2, lib + cross + 2);
}

/** Reads a FASTA's entry count, for the memory estimate and a sanity check. */
export async function countFasta(path: string): Promise<number> {
  const buf = await readFile(path, "utf8");
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf.charCodeAt(i) === 62 && (i === 0 || buf.charCodeAt(i - 1) === 10)) n++;
  }
  return n;
}
