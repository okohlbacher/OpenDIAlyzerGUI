/**
 * The cheap tier: hyparquet over a RangeReader.
 *
 * Footers, page indexes, row-group statistics and small facets. Measured at
 * 2.9-7.1 ms cold open on a 1.5 GB archive, which is fast enough that the bulk
 * tier (parquet-wasm) is not needed until we touch the peak facet.
 *
 * Known limit, and it is structural: hyparquet matches `columns` against
 * `path_in_schema[0]` only, so it cannot project inside a struct. Every mzPeak
 * facet nests under one top-level struct (`point`, `chunk`, `spectrum`), which
 * means asking for `spectrum.time` alone is impossible — you decode every leaf
 * of that struct or none. Fine for metadata; not fine for peaks.
 */
import { parquetMetadataAsync, parquetReadObjects, type FileMetaData } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { RangeReader } from "./range.ts";

/** hyparquet's AsyncBuffer, backed by our one interface. */
export interface AsyncBuffer {
  byteLength: number;
  slice(start: number, end?: number): Promise<ArrayBuffer>;
}

export function asyncBuffer(r: RangeReader): AsyncBuffer {
  return {
    byteLength: r.size,
    async slice(start: number, end?: number): Promise<ArrayBuffer> {
      const from = start < 0 ? r.size + start : start;
      const to = end === undefined ? r.size : end < 0 ? r.size + end : end;
      const bytes = await r.read(from, to - from);
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    },
  };
}

export function readFooter(r: RangeReader): Promise<FileMetaData> {
  return parquetMetadataAsync(asyncBuffer(r));
}

export interface ReadOpts {
  metadata?: FileMetaData;
  /** Top-level column names. Struct children cannot be selected — see above. */
  columns?: string[];
  rowStart?: number;
  rowEnd?: number;
}

export async function readRows<T = Record<string, unknown>>(
  r: RangeReader,
  opts: ReadOpts = {},
): Promise<T[]> {
  return (await parquetReadObjects({
    file: asyncBuffer(r),
    compressors,
    metadata: opts.metadata,
    columns: opts.columns,
    rowStart: opts.rowStart,
    rowEnd: opts.rowEnd,
  })) as T[];
}

/** Total rows across all row groups. */
export function rowCount(md: FileMetaData): number {
  return Number(md.num_rows);
}

export interface RowGroupRange {
  index: number;
  firstRow: number;
  rowCount: number;
}

/** Row-group boundaries as absolute row indices — the unit of pruning. */
export function rowGroupRanges(md: FileMetaData): RowGroupRange[] {
  const out: RowGroupRange[] = [];
  let row = 0;
  md.row_groups.forEach((rg, index) => {
    const n = Number(rg.num_rows);
    out.push({ index, firstRow: row, rowCount: n });
    row += n;
  });
  return out;
}

/**
 * Min/max statistics for one leaf column, per row group.
 *
 * Returns nulls where a row group has no statistics. Useful mostly as evidence:
 * on mzPeak's m/z and TOF columns every row group spans the full axis, which is
 * why every query must be bounded in RT instead (docs/ARCHITECTURE.md).
 */
export function columnStats(
  md: FileMetaData,
  path: string[],
): Array<{ min: unknown; max: unknown } | null> {
  const key = path.join(".");
  return md.row_groups.map((rg) => {
    const col = rg.columns.find((c) => c.meta_data?.path_in_schema.join(".") === key);
    const s = col?.meta_data?.statistics;
    if (!s) return null;
    const min = s.min_value ?? s.min;
    const max = s.max_value ?? s.max;
    if (min === undefined || max === undefined) return null;
    return { min, max };
  });
}
