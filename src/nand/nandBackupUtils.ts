import { nandStore } from './nandChunkStore';

export async function downloadFullNandBin(serial = 'NX'): Promise<{
  filename: string;
  totalBytes: number;
  partitionCount: number;
}> {
  const { bytes, partitionCount, totalBytes } = await nandStore.exportFullNandBin();
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const filename = `rawnand_${serial}_${new Date().toISOString().slice(0, 10)}.bin`;

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { filename, totalBytes, partitionCount };
}

export async function restoreFullNandFromFile(file: File): Promise<{
  partitionCount: number;
  totalBytesRestored: number;
}> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  return nandStore.importFullNandBin(bytes);
}
