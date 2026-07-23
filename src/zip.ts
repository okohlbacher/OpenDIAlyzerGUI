/**
 * Minimal ZIP central-directory reader, ZIP64-aware.
 *
 * Only what mzPeak needs: locate each member's byte range without inflating
 * anything. mzPeak writes every member with CompressionMethod::Stored and the
 * reference reader hard-refuses anything else
 * (vendor/mzpeak_prototyping/src/archive/sync.rs:59, :606-614), so a STORED
 * member's bytes are the file's bytes and a Parquet reader can be pointed
 * straight at them.
 *
 * Every general-purpose unzip library wants the member in memory. That is the
 * one thing we must not do.
 */
import type { RangeReader } from "./range.ts";

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CDH = 0x02014b50;
const SIG_LFH = 0x04034b50;

/** ZIP compression methods we accept. mzPeak facets are always STORED. */
export const STORED = 0;
export const DEFLATE = 8;

export interface ZipMember {
  name: string;
  method: number;
  /** Offset of the member's *data* in the archive — past the local header. */
  dataOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
}

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** 64-bit little-endian read. Sizes here are well under 2^53, so a Number is safe. */
function u64(v: DataView, o: number): number {
  const lo = v.getUint32(o, true);
  const hi = v.getUint32(o + 4, true);
  if (hi > 0x1fffff) throw new RangeError("ZIP64 value exceeds Number.MAX_SAFE_INTEGER");
  return hi * 0x100000000 + lo;
}

/**
 * Reads the central directory. Two round trips in the common case: the tail of
 * the file, then the directory itself.
 */
export async function readCentralDirectory(r: RangeReader): Promise<ZipMember[]> {
  // EOCD is at most 22 + 65535 bytes from the end. Read the tail and scan back.
  const tailLen = Math.min(r.size, 22 + 0xffff);
  const tail = await r.read(r.size - tailLen, tailLen);
  const tv = dv(tail);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive: no end-of-central-directory record");

  let entryCount = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);

  // ZIP64 — mzPeak sets large_file(true), so this is the normal path for real runs.
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entryCount === 0xffff) {
    const locAt = eocd - 20;
    if (locAt < 0 || tv.getUint32(locAt, true) !== SIG_EOCD64_LOCATOR) {
      throw new Error("ZIP64 fields present but no ZIP64 locator found");
    }
    const eocd64At = u64(tv, locAt + 8);
    const e64 = await r.read(eocd64At, 56);
    const ev = dv(e64);
    if (ev.getUint32(0, true) !== SIG_EOCD64) throw new Error("bad ZIP64 EOCD signature");
    entryCount = u64(ev, 32);
    cdSize = u64(ev, 40);
    cdOffset = u64(ev, 48);
  }

  const cd = await r.read(cdOffset, cdSize);
  const cv = dv(cd);
  const members: ZipMember[] = [];
  const decoder = new TextDecoder();

  let p = 0;
  for (let i = 0; i < entryCount; i++) {
    if (cv.getUint32(p, true) !== SIG_CDH) {
      throw new Error(`bad central directory header at entry ${i}`);
    }
    const method = cv.getUint16(p + 10, true);
    const crc32 = cv.getUint32(p + 16, true);
    let compressedSize = cv.getUint32(p + 20, true);
    let uncompressedSize = cv.getUint32(p + 24, true);
    const nameLen = cv.getUint16(p + 28, true);
    const extraLen = cv.getUint16(p + 30, true);
    const commentLen = cv.getUint16(p + 32, true);
    let localHeaderOffset = cv.getUint32(p + 42, true);
    const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen));

    // ZIP64 extended information: only the fields that were 0xFFFFFFFF are
    // present, in this fixed order. Consuming them in order is the whole trick.
    let x = p + 46 + nameLen;
    const extraEnd = x + extraLen;
    while (x + 4 <= extraEnd) {
      const tag = cv.getUint16(x, true);
      const size = cv.getUint16(x + 2, true);
      if (tag === 0x0001) {
        let q = x + 4;
        if (uncompressedSize === 0xffffffff) { uncompressedSize = u64(cv, q); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(cv, q); q += 8; }
        if (localHeaderOffset === 0xffffffff) { localHeaderOffset = u64(cv, q); q += 8; }
        break;
      }
      x += 4 + size;
    }

    members.push({
      name, method, crc32, compressedSize, uncompressedSize,
      // Placeholder: the true data offset needs the *local* header, whose
      // extra field length differs from the central one. Resolved lazily below.
      dataOffset: -localHeaderOffset - 1,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return members;
}

/**
 * Resolves a member's data offset by reading its local header.
 *
 * The local header's extra field is a different length from the central
 * directory's, so the data offset cannot be computed from the central record
 * alone — a mistake that silently yields corrupt reads.
 */
export async function resolveDataOffset(r: RangeReader, m: ZipMember): Promise<number> {
  if (m.dataOffset >= 0) return m.dataOffset;
  const localHeaderOffset = -m.dataOffset - 1;
  const lfh = await r.read(localHeaderOffset, 30);
  const lv = dv(lfh);
  if (lv.getUint32(0, true) !== SIG_LFH) {
    throw new Error(`bad local file header for ${m.name}`);
  }
  const nameLen = lv.getUint16(26, true);
  const extraLen = lv.getUint16(28, true);
  m.dataOffset = localHeaderOffset + 30 + nameLen + extraLen;
  return m.dataOffset;
}
