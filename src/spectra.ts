/**
 * The spectrum index: RT axis, MS level, peak-facet row offsets, and the
 * precursor (isolation window) table.
 *
 * Two structures here, both load-bearing.
 *
 * 1. THE OFFSET TABLE. Random access in the peak facet is otherwise quantised
 *    to a 1,048,576-row row group — the entity-index column has exactly one
 *    page per row group, so a Parquet RowSelection cannot narrow below one, and
 *    fetching a 5,000-peak spectrum decodes ~1 M points. Prefix-summing
 *    `MS_1003059_number_of_peaks` turns "which rows are spectrum N" into
 *    arithmetic. Verified exact on real files: the sum equals the peak-facet
 *    row count to the row (507,184,228 on the 1.53 GB timsTOF corpus).
 *
 * 2. THE PRECURSOR TABLE. For DIA this is the seek path. To extract a
 *    precursor's fragment traces you need the MS2 frames whose isolation window
 *    covers its m/z — that is the only way to turn "peptide at m/z X" into a
 *    set of rows.
 *
 * ── the layout, which is not what it looks like ──────────────────────────────
 *
 * `spectra_metadata.parquet` is NOT one row per spectrum. It packs four
 * independent streams — `spectrum`, `scan`, `precursor`, `selected_ion` — of
 * DIFFERENT lengths into one shared row space, null-padding the shorter ones,
 * batch by batch. Measured on the timsTOF corpus: 61,956 rows carrying 32,700
 * spectra and 61,956 precursors, in 14 alternating runs (rows 0-4999 spectra,
 * 5000-9471 precursor-only, 9472-14471 spectra, …).
 *
 * So the facet's row count is `max(stream lengths)`, and **row position is not
 * spectrum index**. Reading it as one-row-per-spectrum silently yields nulls
 * from row 5000 onward. Streams are individually in ascending index order,
 * which is what makes a single pass sufficient.
 */
import type { MzPeakArchive } from "./archive.ts";
import { FACET } from "./archive.ts";
import { readFooter, readRows, rowCount } from "./parquet.ts";

export interface SpectrumIndex {
  /** Number of spectra — non-null `spectrum` rows, never the facet row count
   *  and never an id-map size (the reference reader panics on duplicate ids
   *  precisely because it uses the latter). */
  readonly count: number;
  /** Retention time in minutes, by spectrum index. */
  readonly time: Float64Array;
  readonly msLevel: Uint8Array;
  readonly peakCount: Uint32Array;
  /** rowStart[i] .. rowStart[i+1] is spectrum i's row range in the peak facet. */
  readonly rowStart: Float64Array;
  readonly totalPeaks: number;
  /** True when ids are not unique — a latent crash in the reference reader. */
  readonly duplicateIds: boolean;
  /**
   * The m/z range the instrument actually recorded for MS2, across the run.
   *
   * Requesting a fragment outside it returns a flat trace that looks exactly
   * like a real absence — which is how a 23-mer's longest y-ions, at 1800–2386
   * Th against an acquisition ending at 1700, were mistaken for "no signal".
   */
  readonly ms2MzRange: readonly [number, number];
}

export interface PrecursorIndex {
  readonly count: number;
  /** The spectrum each isolation window belongs to. */
  readonly spectrumIndex: Uint32Array;
  readonly targetMz: Float64Array;
  readonly lowerOffset: Float64Array;
  readonly upperOffset: Float64Array;
}

export interface MetadataIndex {
  readonly spectra: SpectrumIndex;
  readonly precursors: PrecursorIndex;
  /** Rows in the facet — max of the stream lengths, not the spectrum count. */
  readonly facetRows: number;
}

interface MetaRow {
  spectrum?: {
    index?: bigint | number | null;
    id?: string | null;
    time?: number | null;
    MS_1000511_ms_level?: number | null;
    MS_1000528_lowest_observed_mz_unit_MS_1000040?: number | null;
    MS_1000527_highest_observed_mz_unit_MS_1000040?: number | null;
    MS_1003059_number_of_peaks?: bigint | number | null;
  } | null;
  precursor?: {
    source_index?: bigint | number | null;
    isolation_window?: {
      MS_1000827_isolation_window_target_mz?: number | null;
      MS_1000828_isolation_window_lower_offset?: number | null;
      MS_1000829_isolation_window_upper_offset?: number | null;
    } | null;
  } | null;
}

const num = (v: bigint | number | null | undefined): number | null =>
  v === null || v === undefined ? null : typeof v === "bigint" ? Number(v) : v;

/**
 * Builds both indices in one pass over the metadata facet.
 *
 * hyparquet cannot project inside the `spectrum` struct, so this decodes every
 * leaf. One-off per archive: single-digit ms on small files, ~1.5 s on the
 * 1.5 GB corpus. The result is cached by the caller.
 */
export async function buildMetadataIndex(a: MzPeakArchive): Promise<MetadataIndex> {
  const r = await a.facet(FACET.spectraMetadata);
  const md = await readFooter(r);
  const facetRows = rowCount(md);
  const rows = await readRows<MetaRow>(r, { metadata: md });
  await r.close?.();

  // Pass 1 — how many of each? The streams are independent lengths.
  let nSpectra = 0;
  let nPrecursors = 0;
  for (const row of rows) {
    if (num(row.spectrum?.index) !== null) nSpectra++;
    if (num(row.precursor?.source_index) !== null) nPrecursors++;
  }

  const time = new Float64Array(nSpectra);
  const msLevel = new Uint8Array(nSpectra);
  let ms2Lo = Infinity;
  let ms2Hi = -Infinity;
  const peakCount = new Uint32Array(nSpectra);
  const rowStart = new Float64Array(nSpectra + 1);
  const ids = new Set<string>();
  let sawId = 0;

  const spectrumIndex = new Uint32Array(nPrecursors);
  const targetMz = new Float64Array(nPrecursors);
  const lowerOffset = new Float64Array(nPrecursors);
  const upperOffset = new Float64Array(nPrecursors);

  // Pass 2 — scatter by declared index, never by row position.
  let p = 0;
  for (const row of rows) {
    const s = row.spectrum;
    const si = num(s?.index);
    if (si !== null && s) {
      if (si < 0 || si >= nSpectra) {
        throw new Error(`spectrum index ${si} outside [0, ${nSpectra})`);
      }
      time[si] = s.time ?? 0;
      msLevel[si] = s.MS_1000511_ms_level ?? 0;
      if ((s.MS_1000511_ms_level ?? 0) >= 2) {
        const lo = s.MS_1000528_lowest_observed_mz_unit_MS_1000040;
        const hi = s.MS_1000527_highest_observed_mz_unit_MS_1000040;
        if (typeof lo === "number" && lo > 0 && lo < ms2Lo) ms2Lo = lo;
        if (typeof hi === "number" && hi > ms2Hi) ms2Hi = hi;
      }
      // number_of_peaks indexes spectra_peaks; number_of_data_points is the
      // profile array length and is a different number for profile data.
      peakCount[si] = num(s.MS_1003059_number_of_peaks) ?? 0;
      if (s.id != null) {
        ids.add(s.id);
        sawId++;
      }
    }

    const pr = row.precursor;
    const psi = num(pr?.source_index);
    if (psi !== null && pr) {
      const w = pr.isolation_window;
      spectrumIndex[p] = psi;
      targetMz[p] = w?.MS_1000827_isolation_window_target_mz ?? 0;
      lowerOffset[p] = w?.MS_1000828_isolation_window_lower_offset ?? 0;
      upperOffset[p] = w?.MS_1000829_isolation_window_upper_offset ?? 0;
      p++;
    }
  }

  for (let i = 0; i < nSpectra; i++) rowStart[i + 1] = rowStart[i]! + peakCount[i]!;

  return {
    facetRows,
    spectra: {
      count: nSpectra,
      time,
      msLevel,
      peakCount,
      rowStart,
      totalPeaks: rowStart[nSpectra]!,
      duplicateIds: sawId > 0 && ids.size !== sawId,
      ms2MzRange: [Number.isFinite(ms2Lo) ? ms2Lo : 0,
                   Number.isFinite(ms2Hi) ? ms2Hi : Infinity] as const,
    },
    precursors: { count: nPrecursors, spectrumIndex, targetMz, lowerOffset, upperOffset },
  };
}

/**
 * Confirms the density invariant: that spectrum i occupies rows
 * [rowStart[i], rowStart[i+1]) of the peak facet.
 *
 * Nothing in the format declares this, so it is checked rather than trusted.
 * Samples rather than scanning — reading 507 M rows to validate an index would
 * defeat the index.
 */
export async function verifyOffsets(
  a: MzPeakArchive,
  idx: SpectrumIndex,
  samples = 8,
): Promise<{ checked: number[]; totalRowsMatch: boolean; coverage: number }> {
  const r = await a.facet(FACET.spectraPeaks);
  const md = await readFooter(r);
  const totalRowsMatch = rowCount(md) === idx.totalPeaks;

  // hyparquet cannot read past the first data page of a DELTA_BINARY_PACKED
  // column, which is what `point.spectrum_index` uses — measured cutoff row
  // 540,896 on the timsTOF corpus, well inside row group 0. Rows beyond it come
  // back undefined rather than erroring, so probe the limit instead of assuming
  // it. Full-file verification lands with the bulk tier (M2).
  const readable = await cheapTierLimit(r, md, rowCount(md));

  const checked: number[] = [];
  for (let k = 0; k < samples; k++) {
    let i = Math.floor(((k + 0.5) / samples) * idx.count);
    let guard = 0;
    while (i < idx.count && idx.peakCount[i] === 0 && guard++ < 1000) i++;
    if (i >= idx.count || idx.peakCount[i] === 0) continue;

    const start = idx.rowStart[i]!;
    const end = idx.rowStart[i + 1]!;
    if (end > readable) continue;
    const rows = await readRows<{ point?: { spectrum_index?: bigint | number } }>(r, {
      metadata: md,
      rowStart: start,
      rowEnd: Math.min(end, start + 64),
    });
    for (const row of rows) {
      const si = num(row.point?.spectrum_index);
      if (si !== i) {
        throw new Error(
          `offset table wrong: rows [${start},${end}) should be spectrum ${i}, row holds ${si}`,
        );
      }
    }
    checked.push(i);
  }
  await r.close?.();
  return { checked, totalRowsMatch, coverage: readable / Math.max(1, idx.totalPeaks) };
}

/**
 * Highest peak-facet row the cheap tier can actually decode, by binary search.
 *
 * Exists because hyparquet fails *silently* — it returns rows whose struct is
 * undefined rather than throwing — and a silent wrong answer is worse than a
 * slow one. Removed once the bulk tier owns this facet.
 */
async function cheapTierLimit(
  r: Awaited<ReturnType<MzPeakArchive["facet"]>>,
  md: Awaited<ReturnType<typeof readFooter>>,
  total: number,
): Promise<number> {
  const readable = async (row: number): Promise<boolean> => {
    const got = await readRows<{ point?: { spectrum_index?: bigint | number } }>(r, {
      metadata: md,
      rowStart: row,
      rowEnd: row + 1,
    });
    return num(got[0]?.point?.spectrum_index) !== null;
  };
  if (await readable(total - 1)) return total;
  let lo = 0;
  let hi = total - 1;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await readable(mid)) lo = mid;
    else hi = mid;
  }
  return lo + 1;
}

/** Spectrum indices with RT in [t0, t1] minutes, optionally one MS level. */
export function spectraInRtWindow(
  idx: SpectrumIndex,
  t0: number,
  t1: number,
  msLevel?: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < idx.count; i++) {
    const t = idx.time[i]!;
    if (t < t0 || t > t1) continue;
    if (msLevel !== undefined && idx.msLevel[i] !== msLevel) continue;
    out.push(i);
  }
  return out;
}

/**
 * MS2 spectra in an RT window whose isolation window covers `mz`.
 *
 * This is the DIA seek path: it turns "the peptide at m/z 614.98, eluting at
 * 8.87 min" into a concrete set of spectra, which the offset table then turns
 * into concrete peak-facet row ranges.
 */
export function framesCovering(
  meta: MetadataIndex,
  mz: number,
  t0: number,
  t1: number,
): number[] {
  const { spectra, precursors } = meta;
  const hit = new Set<number>();
  for (let p = 0; p < precursors.count; p++) {
    const lo = precursors.targetMz[p]! - precursors.lowerOffset[p]!;
    const hi = precursors.targetMz[p]! + precursors.upperOffset[p]!;
    if (mz < lo || mz > hi) continue;
    const s = precursors.spectrumIndex[p]!;
    const t = spectra.time[s];
    if (t === undefined || t < t0 || t > t1) continue;
    hit.add(s);
  }
  return [...hit].sort((x, y) => x - y);
}
