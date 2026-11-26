import { crc32 } from './crc32';
import { NxfsFileEntry } from './nandTypes';

export const NAND_CHUNK_SIZE = 16384; // 16 KiB per IndexedDB Uint8Array chunk

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Pure binary NXFS v2 filesystem container (zero JSON):
 * [0..3]   Magic: "NXFS" (0x4E 0x58 0x46 0x53)
 * [4..7]   Version: uint32 LE (2)
 * [8..11]  Entry Count: uint32 LE
 * [12..15] Data Payload CRC32: uint32 LE
 * [16..]   Binary File Table:
 *            For each entry:
 *              uint16 pathByteLength
 *              uint8[pathByteLength] UTF-8 path
 *              uint32 offset (from payload start)
 *              uint32 length
 *              uint32 fileCrc32
 *          Followed immediately by concatenated file byte payloads
 */
export function packNxfs(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: NxfsFileEntry[] = [];
  const encodedParts: Uint8Array[] = [];
  let currentOffset = 0;

  const paths = Object.keys(files).sort();
  let tableByteSize = 0;
  const pathBytesList: Uint8Array[] = [];

  for (const path of paths) {
    const raw = files[path];
    const bytes = typeof raw === 'string' ? encoder.encode(raw) : raw;
    const pBytes = encoder.encode(path);
    pathBytesList.push(pBytes);
    tableByteSize += 2 + pBytes.length + 12;

    entries.push({
      path,
      offset: currentOffset,
      length: bytes.length,
      crc32: crc32(bytes),
    });
    encodedParts.push(bytes);
    currentOffset += bytes.length;
  }

  const payloadBytes = new Uint8Array(currentOffset);
  let writePos = 0;
  for (const part of encodedParts) {
    payloadBytes.set(part, writePos);
    writePos += part.length;
  }

  const payloadCrc = crc32(payloadBytes);
  const totalLength = 16 + tableByteSize + payloadBytes.length;
  const image = new Uint8Array(totalLength);
  const view = new DataView(image.buffer);

  // Magic "NXFS"
  image[0] = 0x4e; // N
  image[1] = 0x58; // X
  image[2] = 0x46; // F
  image[3] = 0x53; // S
  view.setUint32(4, 2, true); // Binary NXFS v2
  view.setUint32(8, entries.length, true);
  view.setUint32(12, payloadCrc, true);

  let tablePos = 16;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const pBytes = pathBytesList[i];
    view.setUint16(tablePos, pBytes.length, true);
    tablePos += 2;
    image.set(pBytes, tablePos);
    tablePos += pBytes.length;
    view.setUint32(tablePos, entry.offset, true);
    view.setUint32(tablePos + 4, entry.length, true);
    view.setUint32(tablePos + 8, entry.crc32, true);
    tablePos += 12;
  }

  image.set(payloadBytes, tablePos);
  return image;
}

export interface UnpackedNxfs {
  entries: NxfsFileEntry[];
  files: Record<string, Uint8Array>;
}

export function unpackNxfs(image: Uint8Array): UnpackedNxfs {
  if (image.length < 16) {
    throw new Error('NXFS header truncated (< 16 bytes)');
  }
  const magic = String.fromCharCode(image[0], image[1], image[2], image[3]);
  if (magic !== 'NXFS') {
    throw new Error(`Invalid filesystem magic "${magic}" (expected "NXFS")`);
  }

  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const version = view.getUint32(4, true);
  if (version !== 2) {
    throw new Error(`Unsupported NXFS version ${version} (expected binary v2)`);
  }

  const entryCount = view.getUint32(8, true);
  const expectedPayloadCrc = view.getUint32(12, true);

  let pos = 16;
  const entries: NxfsFileEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (pos + 2 > image.length) {
      throw new Error('NXFS binary file table truncated');
    }
    const pathLen = view.getUint16(pos, true);
    pos += 2;
    if (pos + pathLen + 12 > image.length) {
      throw new Error('NXFS binary directory entry out of bounds');
    }
    const path = decoder.decode(image.subarray(pos, pos + pathLen));
    pos += pathLen;
    const offset = view.getUint32(pos, true);
    const length = view.getUint32(pos + 4, true);
    const fileCrc = view.getUint32(pos + 8, true);
    pos += 12;
    entries.push({ path, offset, length, crc32: fileCrc });
  }

  const payload = image.subarray(pos);
  const actualPayloadCrc = crc32(payload);

  if (actualPayloadCrc !== expectedPayloadCrc) {
    throw new Error(
      `NXFS payload CRC32 mismatch (expected 0x${expectedPayloadCrc
        .toString(16)
        .toUpperCase()}, got 0x${actualPayloadCrc.toString(16).toUpperCase()})`
    );
  }

  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    if (entry.offset + entry.length > payload.length) {
      throw new Error(`File "${entry.path}" truncated inside NXFS image`);
    }
    const slice = payload.slice(entry.offset, entry.offset + entry.length);
    const fileCrc = crc32(slice);
    if (fileCrc !== entry.crc32) {
      throw new Error(`File "${entry.path}" failed CRC32 integrity verification`);
    }
    files[entry.path] = slice;
  }

  return { entries, files };
}

export function splitIntoChunks(
  data: Uint8Array,
  chunkSize = NAND_CHUNK_SIZE
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  if (data.length === 0) {
    chunks.push(new Uint8Array(0));
    return chunks;
  }
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, data.length);
    chunks.push(data.slice(offset, end));
  }
  return chunks;
}

export function reassembleChunks(chunks: Uint8Array[]): Uint8Array {
  const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
