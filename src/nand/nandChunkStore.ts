import {
  BinaryReader,
  BinaryWriter,
  decodeAcal,
  decodeAlb0,
  decodeBat0,
  decodeCal0,
  decodeCap0,
  decodeEsh0,
  decodeFca0,
  decodeHosm,
  decodeIcal,
  decodeNws0,
  decodePrf0,
  decodeQapp,
  decodeSet0,
  decodeSfx0,
  decodeStr0,
  decodeTcal,
  decodeThm0,
  decodeTit0,
  verifyTrailingCrc32,
} from './binaryStructs';
import { bytesEqual, bytesToHex, crc32, sha256Bytes, sha256Hex, sha256HexSync } from './crc32';
import {
  buildFactoryPartitionSpecs,
  decodeGameSave,
  decodeKeyblobBinary,
  FactoryPartitionSpec,
  getMasterKeyHashHex,
} from './nandFactoryImage';
import {
  NAND_CHUNK_SIZE,
  packNxfs,
  reassembleChunks,
  splitIntoChunks,
  unpackNxfs,
} from './nandFs';
import {
  NandAuditCheck,
  NandAuditReport,
  NandChunkRecord,
  NandIoEvent,
  NandPartitionMeta,
  PartitionId,
} from './nandTypes';
import { executeBatteryPolicyVm, NXVM_REG } from './nxVm';
import {
  decodeArtworkPack,
  decodeAvatarGlyphs,
  decodeBootChime,
  decodeBootSplash,
  decodeChromaticData,
  decodeQlaunchNro,
  decodeQuizPackage,
  decodeSpriteAtlas,
  decodeStellarData,
  decodeTetrominoData,
} from './systemAssets';

const DB_NAME = 'nx_nand_emmc_v1';
const DB_VERSION = 6;
const STORE_GPT = 'gpt_table';
const STORE_CHUNKS = 'nand_chunks';

type IoListener = (event: NandIoEvent) => void;

class NandChunkStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private ioListeners = new Set<IoListener>();
  private ioSeq = 1;
  private recentIo: NandIoEvent[] = [];

  public subscribeIo(listener: IoListener): () => void {
    this.ioListeners.add(listener);
    return () => this.ioListeners.delete(listener);
  }

  public getRecentIo(): NandIoEvent[] {
    return this.recentIo;
  }

  private emitIo(
    op: NandIoEvent['op'],
    partitionId: PartitionId,
    chunkRange: string,
    bytes: number,
    crcOk: boolean,
    detail: string
  ): void {
    const evt: NandIoEvent = {
      id: this.ioSeq++,
      timestamp: Date.now(),
      op,
      partitionId,
      chunkRange,
      bytes,
      crcOk,
      detail,
    };
    this.recentIo = [evt, ...this.recentIo].slice(0, 60);
    this.ioListeners.forEach((fn) => fn(evt));
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const tx = req.transaction;
        if (!db.objectStoreNames.contains(STORE_GPT)) {
          db.createObjectStore(STORE_GPT, { keyPath: 'id' });
        } else if (event.oldVersion > 0 && event.oldVersion < DB_VERSION && tx) {
          tx.objectStore(STORE_GPT).clear();
        }
        if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
          const store = db.createObjectStore(STORE_CHUNKS, { keyPath: 'key' });
          store.createIndex('by_partition', 'partitionId', { unique: false });
        } else if (event.oldVersion > 0 && event.oldVersion < DB_VERSION && tx) {
          tx.objectStore(STORE_CHUNKS).clear();
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB NAND'));
    });
    return this.dbPromise;
  }

  public async isProvisioned(): Promise<boolean> {
    const db = await this.openDb();
    return new Promise((resolve) => {
      const tx = db.transaction([STORE_GPT, STORE_CHUNKS], 'readonly');
      const gptReq = tx.objectStore(STORE_GPT).count();
      const chunkReq = tx.objectStore(STORE_CHUNKS).count();
      tx.oncomplete = () => {
        resolve(gptReq.result >= 8 && chunkReq.result >= 8);
      };
      tx.onerror = () => resolve(false);
    });
  }

  public async ensureProvisioned(
    onProgress?: (partitionId: PartitionId, chunkCount: number) => void
  ): Promise<boolean> {
    const ready = await this.isProvisioned();
    if (ready) return false;
    await this.flashFactoryNand(onProgress);
    return true;
  }

  public async flashFactoryNand(
    onProgress?: (partitionId: PartitionId, chunkCount: number) => void
  ): Promise<void> {
    const db = await this.openDb();
    const specs = buildFactoryPartitionSpecs();

    // Clear existing stores cleanly
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_GPT, STORE_CHUNKS], 'readwrite');
      tx.objectStore(STORE_GPT).clear();
      tx.objectStore(STORE_CHUNKS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    for (const spec of specs) {
      const count = await this.writePartitionImageInternal(db, spec, spec.image);
      this.emitIo(
        'FLASH',
        spec.id,
        `0..${count - 1}`,
        spec.image.length,
        true,
        `Provisioned ${count} Uint8Array chunks (${NAND_CHUNK_SIZE}B/chunk)`
      );
      onProgress?.(spec.id, count);
    }
  }

  private async writePartitionImageInternal(
    db: IDBDatabase,
    spec: Omit<FactoryPartitionSpec, 'image'>,
    image: Uint8Array
  ): Promise<number> {
    const chunks = splitIntoChunks(image, NAND_CHUNK_SIZE);
    const partCrc = crc32(image);
    const partSha = await sha256Hex(image);

    const meta: NandPartitionMeta = {
      id: spec.id,
      gptIndex: spec.gptIndex,
      label: spec.label,
      description: spec.description,
      requiredBy: spec.requiredBy,
      virtualCapacityBytes: spec.virtualCapacityBytes,
      chunkSize: NAND_CHUNK_SIZE,
      chunkCount: chunks.length,
      usedBytes: image.length,
      partitionCrc32: partCrc,
      sha256: partSha,
      encrypted: spec.encrypted,
      startLba: spec.startLba,
      endLba: spec.endLba,
      updatedAt: Date.now(),
    };

    const existingKeys = await this.getChunkKeysForPartition(db, spec.id);

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_GPT, STORE_CHUNKS], 'readwrite');
      const gptStore = tx.objectStore(STORE_GPT);
      const chunkStore = tx.objectStore(STORE_CHUNKS);

      gptStore.put(meta);

      // Remove stale tail chunks if partition shrank
      for (const oldKey of existingKeys) {
        const idx = Number(oldKey.split(':')[1]);
        if (idx >= chunks.length) {
          chunkStore.delete(oldKey);
        }
      }

      chunks.forEach((chunkData, idx) => {
        const record: NandChunkRecord = {
          key: `${spec.id}:${idx}`,
          partitionId: spec.id,
          chunkIndex: idx,
          data: chunkData,
          byteLength: chunkData.length,
          crc32: crc32(chunkData),
          writtenAt: Date.now(),
        };
        chunkStore.put(record);
      });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    return chunks.length;
  }

  private getChunkKeysForPartition(
    db: IDBDatabase,
    partitionId: PartitionId
  ): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CHUNKS, 'readonly');
      const index = tx.objectStore(STORE_CHUNKS).index('by_partition');
      const req = index.getAllKeys(partitionId);
      req.onsuccess = () => resolve(req.result as string[]);
      req.onerror = () => reject(req.error);
    });
  }

  public async listPartitions(): Promise<NandPartitionMeta[]> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_GPT, 'readonly');
      const req = tx.objectStore(STORE_GPT).getAll();
      req.onsuccess = () => {
        const list = (req.result as NandPartitionMeta[]).sort(
          (a, b) => a.gptIndex - b.gptIndex
        );
        resolve(list);
      };
      req.onerror = () => reject(req.error);
    });
  }

  public async getPartitionMeta(
    partitionId: PartitionId
  ): Promise<NandPartitionMeta | null> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_GPT, 'readonly');
      const req = tx.objectStore(STORE_GPT).get(partitionId);
      req.onsuccess = () => resolve((req.result as NandPartitionMeta) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  public async getPartitionChunkRecords(
    partitionId: PartitionId
  ): Promise<NandChunkRecord[]> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CHUNKS, 'readonly');
      const index = tx.objectStore(STORE_CHUNKS).index('by_partition');
      const req = index.getAll(partitionId);
      req.onsuccess = () => {
        const rows = (req.result as NandChunkRecord[]).sort(
          (a, b) => a.chunkIndex - b.chunkIndex
        );
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });
  }

  public async readPartitionImage(partitionId: PartitionId): Promise<{
    meta: NandPartitionMeta;
    chunks: NandChunkRecord[];
    image: Uint8Array;
    corruptedChunkIndex: number | null;
  }> {
    const meta = await this.getPartitionMeta(partitionId);
    if (!meta) {
      this.emitIo('READ', partitionId, 'N/A', 0, false, 'GPT entry missing');
      throw new Error(`Partition ${partitionId} not found in GPT`);
    }

    const chunks = await this.getPartitionChunkRecords(partitionId);
    if (chunks.length === 0 || chunks.length !== meta.chunkCount) {
      this.emitIo(
        'READ',
        partitionId,
        `0..${meta.chunkCount - 1}`,
        0,
        false,
        `Expected ${meta.chunkCount} chunks, found ${chunks.length}`
      );
      throw new Error(
        `Partition ${partitionId} chunk sequence incomplete (${chunks.length}/${meta.chunkCount})`
      );
    }

    let corruptedChunkIndex: number | null = null;
    for (let i = 0; i < chunks.length; i++) {
      const rec = chunks[i];
      if (rec.chunkIndex !== i) {
        corruptedChunkIndex = i;
        break;
      }
      const actualCrc = crc32(rec.data);
      if (actualCrc !== rec.crc32) {
        corruptedChunkIndex = i;
        break;
      }
    }

    const image = reassembleChunks(chunks.map((c) => c.data));
    const wholeCrcOk =
      corruptedChunkIndex === null && crc32(image) === meta.partitionCrc32;

    this.emitIo(
      'READ',
      partitionId,
      `0..${chunks.length - 1}`,
      image.length,
      wholeCrcOk,
      wholeCrcOk
        ? `Read ${chunks.length} chunks (${image.length} bytes), CRC32 verified`
        : `CRC32 mismatch at chunk #${corruptedChunkIndex ?? 0}`
    );

    return { meta, chunks, image, corruptedChunkIndex };
  }

  public async readPartitionFiles(partitionId: PartitionId): Promise<{
    meta: NandPartitionMeta;
    chunks: NandChunkRecord[];
    files: Record<string, Uint8Array>;
  }> {
    const { meta, chunks, image, corruptedChunkIndex } =
      await this.readPartitionImage(partitionId);

    if (corruptedChunkIndex !== null) {
      throw new Error(
        `NAND chunk CRC32 corruption detected in ${partitionId} chunk #${corruptedChunkIndex}`
      );
    }

    const unpacked = unpackNxfs(image);
    return { meta, chunks, files: unpacked.files };
  }

  public async updatePartitionFile(
    partitionId: PartitionId,
    filePath: string,
    content: string | Uint8Array
  ): Promise<NandPartitionMeta> {
    const db = await this.openDb();
    const { meta, files } = await this.readPartitionFiles(partitionId);
    const updatedFiles: Record<string, string | Uint8Array> = { ...files };
    updatedFiles[filePath] = content;

    const newImage = packNxfs(updatedFiles);
    const count = await this.writePartitionImageInternal(
      db,
      {
        id: meta.id,
        gptIndex: meta.gptIndex,
        label: meta.label,
        description: meta.description,
        requiredBy: meta.requiredBy,
        virtualCapacityBytes: meta.virtualCapacityBytes,
        encrypted: meta.encrypted,
        startLba: meta.startLba,
        endLba: meta.endLba,
      },
      newImage
    );

    this.emitIo(
      'WRITE',
      partitionId,
      `0..${count - 1}`,
      newImage.length,
      true,
      `Updated ${filePath} -> wrote ${count} chunks`
    );

    const refreshed = await this.getPartitionMeta(partitionId);
    return refreshed!;
  }

  public async deletePartitionFile(
    partitionId: PartitionId,
    filePath: string
  ): Promise<NandPartitionMeta> {
    const db = await this.openDb();
    const { meta, files } = await this.readPartitionFiles(partitionId);
    const updatedFiles: Record<string, string | Uint8Array> = { ...files };
    delete updatedFiles[filePath];

    const newImage = packNxfs(updatedFiles);
    const count = await this.writePartitionImageInternal(
      db,
      {
        id: meta.id,
        gptIndex: meta.gptIndex,
        label: meta.label,
        description: meta.description,
        requiredBy: meta.requiredBy,
        virtualCapacityBytes: meta.virtualCapacityBytes,
        encrypted: meta.encrypted,
        startLba: meta.startLba,
        endLba: meta.endLba,
      },
      newImage
    );

    this.emitIo(
      'WRITE',
      partitionId,
      `0..${count - 1}`,
      newImage.length,
      true,
      `Deleted ${filePath} -> wrote ${count} chunks`
    );

    const refreshed = await this.getPartitionMeta(partitionId);
    return refreshed!;
  }

  /**
   * Performs an exhaustive cryptographic and structural audit of the entire NAND eMMC dump.
   * Verifies chunk CRC32/SHA-256 digests, exact GPT LBA capacity & encryption metadata honesty,
   * full Stage 1 -> Stage 2 -> KIP1 SHA-256 chain, calibration binaries, SYSTEM, and USER sync.
   */
  public async auditNandConsistency(): Promise<NandAuditReport> {
    const checks: NandAuditCheck[] = [];
    const textDecoder = new TextDecoder();

    // 1. GPT Geometry, Exact Sector Capacity & Encryption Flag Honesty
    let parts: NandPartitionMeta[] = [];
    try {
      parts = (await this.listPartitions()).sort((a, b) => a.gptIndex - b.gptIndex);
      const has8 = parts.length === 8;
      let contiguousOk = true;
      let capacityOk = true;
      let honestyOk = true;
      let nextExpectedLba = 0;

      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.gptIndex !== i || p.startLba !== nextExpectedLba || p.endLba < p.startLba) {
          contiguousOk = false;
        }
        nextExpectedLba = p.endLba + 1;
        const sectorBytes = (p.endLba - p.startLba + 1) * 512;
        if (sectorBytes !== p.virtualCapacityBytes || p.usedBytes > p.virtualCapacityBytes) {
          capacityOk = false;
        }
        if (p.encrypted) {
          honestyOk = false;
        }
      }

      checks.push({
        id: 'gpt-geometry',
        category: 'GPT',
        label: 'GPT Geometry, LBA Sectors & Cleartext Honesty',
        passed: has8 && contiguousOk && capacityOk && honestyOk,
        detail: `${parts.length}/8 partitions · contiguous=${contiguousOk ? 'OK' : 'FAIL'} · 512B LBA==capacity=${capacityOk ? 'OK' : 'FAIL'} · encrypted=false=${honestyOk ? 'OK' : 'MISMATCH'}`,
      });
    } catch (err) {
      checks.push({
        id: 'gpt-geometry',
        category: 'GPT',
        label: 'GPT Geometry, LBA Sectors & Cleartext Honesty',
        passed: false,
        detail: String(err),
      });
    }

    // 2. CHUNKS: Per-chunk CRC32 & Whole-Partition CRC32 + SHA-256
    try {
      let totalChunksChecked = 0;
      let badChunks = 0;
      let badPartitions = 0;

      for (const meta of parts) {
        const chunks = await this.getPartitionChunkRecords(meta.id);
        if (chunks.length !== meta.chunkCount || chunks.length === 0) {
          badPartitions++;
          continue;
        }
        for (let i = 0; i < chunks.length; i++) {
          totalChunksChecked++;
          const rec = chunks[i];
          if (
            rec.chunkIndex !== i ||
            rec.data.length !== rec.byteLength ||
            crc32(rec.data) !== rec.crc32
          ) {
            badChunks++;
          }
        }
        const raw = reassembleChunks(chunks.map((c) => c.data));
        if (
          raw.length !== meta.usedBytes ||
          crc32(raw) !== meta.partitionCrc32 ||
          sha256HexSync(raw) !== meta.sha256
        ) {
          badPartitions++;
        }
      }

      checks.push({
        id: 'chunks-crc-sha256',
        category: 'CHUNKS',
        label: 'IndexedDB Chunk CRC32 & Partition SHA-256 Store',
        passed: parts.length === 8 && badChunks === 0 && badPartitions === 0,
        detail: `${totalChunksChecked} chunks verified (${badChunks} CRC errors, ${badPartitions} partition digest mismatches)`,
      });
    } catch (err) {
      checks.push({
        id: 'chunks-crc-sha256',
        category: 'CHUNKS',
        label: 'IndexedDB Chunk CRC32 & Partition SHA-256 Store',
        passed: false,
        detail: String(err),
      });
    }

    let bctSerial = '';
    let bctEntryPoint = 0;
    let bctKeyblobSha256: Uint8Array = new Uint8Array(32);
    let actualBoot1Sha256: Uint8Array = new Uint8Array(32);
    let nxBoot1Stage2Size = 0;
    let nxBoot1Stage2Sha256: Uint8Array = new Uint8Array(32);

    let prodInfoSerial = '';
    let prodInfoFuses = 0;
    let kbPkg2Sha256: Uint8Array = new Uint8Array(32);

    let pk21VersionStr = '';
    let pk21KernelEntry = 0;
    const expectedKipManifest: Array<{ name: string; size: number; sha256: Uint8Array }> = [];

    // 3. BOOT0: BCT0, STG1, and NX_BOOT1 SHA-256 Root Verification
    try {
      const { files } = await this.readPartitionFiles('BOOT0');
      const bct = files['/boot/bct.bin'];
      const nxBoot1 = files['/boot/nx_boot1.bin'];
      const stg1Hdr = files['/boot/stage1.hdr'];
      if (!bct || bct.length < 1024) throw new Error('Missing /boot/bct.bin');
      if (!nxBoot1 || nxBoot1.length < 116) throw new Error('Missing /boot/nx_boot1.bin');
      if (!stg1Hdr) throw new Error('Missing /boot/stage1.hdr');

      const bctMagic = String.fromCharCode(bct[0], bct[1], bct[2], bct[3]);
      const bctView = new DataView(bct.buffer, bct.byteOffset, bct.byteLength);
      const bctOk =
        bctMagic === 'BCT0' && bctView.getUint32(1020, true) === crc32(bct.subarray(0, 1020));

      bctEntryPoint = bctView.getUint32(0x08, true);
      const bctStage1Size = bctView.getUint32(0x10, true);
      const dramMhz = bctView.getUint32(0x14, true);

      const sBytes = bct.subarray(0x20, 0x40);
      const zIdx = sBytes.indexOf(0);
      bctSerial = textDecoder.decode(zIdx >= 0 ? sBytes.subarray(0, zIdx) : sBytes).trim();
      bctKeyblobSha256 = bct.slice(0x100, 0x120);
      const bctBoot1Sha256 = bct.subarray(0x120, 0x140);

      const boot1View = new DataView(nxBoot1.buffer, nxBoot1.byteOffset, nxBoot1.byteLength);
      const boot1Sig = textDecoder.decode(nxBoot1.subarray(0, 8));
      const boot1CrcOk =
        boot1View.getUint32(nxBoot1.length - 4, true) === crc32(nxBoot1.subarray(0, nxBoot1.length - 4));
      const boot1EntryPoint = boot1View.getUint32(8, true);

      actualBoot1Sha256 = sha256Bytes(nxBoot1);
      const boot1HashMatch = bytesEqual(actualBoot1Sha256, bctBoot1Sha256);
      const boot1SizeMatch = nxBoot1.length === bctStage1Size;

      nxBoot1Stage2Size = boot1View.getUint32(0x4c, true);
      nxBoot1Stage2Sha256 = nxBoot1.slice(0x50, 0x70);

      verifyTrailingCrc32(stg1Hdr, 'BOOT0 STG1');
      const sr = new BinaryReader(stg1Hdr);
      const stg1Magic = sr.readMagic(4);
      sr.readU8();
      sr.readU8();
      sr.readU16();
      const stg1Entry = sr.readU32();
      const stg1Target = sr.readFixedString(16);
      const stg1Size = sr.readU32();
      const stg1Sha = sr.readBytes(32);
      const stg1Ok =
        stg1Magic === 'STG1' &&
        stg1Entry === bctEntryPoint &&
        stg1Target === 'BOOT1' &&
        stg1Size === nxBoot1.length &&
        bytesEqual(stg1Sha, actualBoot1Sha256);

      checks.push({
        id: 'boot0-bct-boot1',
        category: 'BOOT0',
        label: 'BOOT0 BCT0, STG1 & NX_BOOT1 SHA-256 Chain',
        passed: bctOk && boot1Sig === 'NX_BOOT1' && boot1CrcOk && boot1HashMatch && boot1SizeMatch && stg1Ok,
        detail: `BCT0 @ ${dramMhz}MHz (${bctOk ? 'OK' : 'FAIL'}) · NX_BOOT1 ${nxBoot1.length}B SHA-256 ${bytesToHex(actualBoot1Sha256.subarray(0, 6))}… (${boot1HashMatch ? 'Pinned' : 'Mismatch'}) · STG1 (${stg1Ok ? 'OK' : 'FAIL'})`,
      });

      const vectorMatch = bctEntryPoint === boot1EntryPoint;
      checks.push({
        id: 'boot0-entry-crosscheck',
        category: 'BOOT0',
        label: 'Stage 1 IRAM Vector Alignment',
        passed: vectorMatch,
        detail: `BCT0 entry 0x${bctEntryPoint.toString(16).toUpperCase()} ${vectorMatch ? '==' : '!='} NX_BOOT1 base 0x${boot1EntryPoint.toString(16).toUpperCase()}`,
      });
    } catch (err) {
      checks.push({
        id: 'boot0-bct-boot1',
        category: 'BOOT0',
        label: 'BOOT0 BCT0, STG1 & NX_BOOT1 SHA-256 Chain',
        passed: false,
        detail: String(err),
      });
    }

    // 4. PRODINFO: CAL0, KB00 SHA-256, and TCAL/ACAL/ICAL Sensors
    try {
      const { files } = await this.readPartitionFiles('PRODINFO');
      const calBytes = files['/cal/prodinfo.bin'];
      const kbBytes = files['/cal/cal0_keyblob.bin'];
      const tcalBytes = files['/cal/touch_cal.bin'];
      const acalBytes = files['/cal/audio_cal.bin'];
      const icalBytes = files['/cal/imu_cal.bin'];
      if (!calBytes || !kbBytes || !tcalBytes || !acalBytes || !icalBytes) {
        throw new Error('Missing calibration binaries inside PRODINFO');
      }

      const cal = decodeCal0(calBytes);
      prodInfoSerial = cal.serial;
      prodInfoFuses = cal.fuseCount;

      const kb = decodeKeyblobBinary(kbBytes);
      kbPkg2Sha256 = kb.pkg2Sha256;
      const kbBctMatch = bytesEqual(sha256Bytes(kbBytes), bctKeyblobSha256);
      const kbBoot1Match = bytesEqual(kb.pkg1Sha256, actualBoot1Sha256);
      const expectedRev18Hash = getMasterKeyHashHex(18);
      const keyHashMatch = cal.masterKeyHash === expectedRev18Hash;

      const tc = decodeTcal(tcalBytes);
      const ac = decodeAcal(acalBytes);
      const ic = decodeIcal(icalBytes);
      const sensorsOk = tc.width > 0 && ac.codec.length > 0 && ic.sensor.length > 0;

      checks.push({
        id: 'prodinfo-cal0-kb00',
        category: 'PRODINFO',
        label: 'PRODINFO CAL0, KB00 & Sensor Calibration',
        passed: kbBctMatch && kbBoot1Match && keyHashMatch && sensorsOk,
        detail: `KB00<->BCT0 (${kbBctMatch ? 'OK' : 'FAIL'}) · Rev18 Key (${keyHashMatch ? 'OK' : 'FAIL'}) · Sensors ${tc.width}x${tc.height}/${ac.codec}/${ic.sensor}`,
      });

      const serialMatch = bctSerial === prodInfoSerial;
      checks.push({
        id: 'serial-consistency',
        category: 'PRODINFO',
        label: 'Console Identity Serial Consistency',
        passed: serialMatch,
        detail: `BCT0 serial "${bctSerial}" ${serialMatch ? '==' : '!='} PRODINFO "${prodInfoSerial}"`,
      });
    } catch (err) {
      checks.push({
        id: 'prodinfo-cal0-kb00',
        category: 'PRODINFO',
        label: 'PRODINFO CAL0, KB00 & Sensor Calibration',
        passed: false,
        detail: String(err),
      });
    }

    // 5. BOOT1: Package2 PK21 SHA-256 Chain, STG2 & Anti-Rollback Fuses
    try {
      const { files } = await this.readPartitionFiles('BOOT1');
      const pk21 = files['/pk21/package2.bin'];
      const stg2Hdr = files['/pk21/stage2.hdr'];
      if (!pk21 || pk21.length < 400 || !stg2Hdr) throw new Error('Missing PK21 or STG2');
      const pkMagic = String.fromCharCode(pk21[0], pk21[1], pk21[2], pk21[3]);
      verifyTrailingCrc32(pk21, 'BOOT1 PK21');

      const pkSha = sha256Bytes(pk21);
      const boot1PinnedMatch = pk21.length === nxBoot1Stage2Size && bytesEqual(pkSha, nxBoot1Stage2Sha256);
      const kbPinnedMatch = bytesEqual(pkSha, kbPkg2Sha256);

      const pkView = new DataView(pk21.buffer, pk21.byteOffset, pk21.byteLength);
      pk21KernelEntry = pkView.getUint32(4, true);
      const pkVer = pkView.getUint32(8, true);
      pk21VersionStr = `${(pkVer >> 16) & 0xff}.${(pkVer >> 8) & 0xff}.${pkVer & 0xff}`;
      const kipCount = pkView.getUint32(0x0c, true);

      verifyTrailingCrc32(stg2Hdr, 'BOOT1 STG2');
      const sr2 = new BinaryReader(stg2Hdr);
      const stg2Ok =
        sr2.readMagic(4) === 'STG2' &&
        sr2.readU8() === 2 &&
        sr2.readU8() === kipCount &&
        (sr2.readU16(), sr2.readU32() === pk21KernelEntry) &&
        sr2.readFixedString(8) === 'PK21' &&
        sr2.readU32() === pk21.length &&
        bytesEqual(sr2.readBytes(32), pkSha);

      const mr = new BinaryReader(pk21);
      mr.pos = 0x30;
      for (let i = 0; i < kipCount; i++) {
        expectedKipManifest.push({
          name: mr.readFixedString(16),
          size: mr.readU32(),
          sha256: mr.readBytes(32),
        });
      }

      checks.push({
        id: 'boot1-package2',
        category: 'BOOT1',
        label: 'BOOT1 Package2 PK21 & STG2 SHA-256 Chain',
        passed: pkMagic === 'PK21' && boot1PinnedMatch && kbPinnedMatch && stg2Ok,
        detail: `PK21 ${pk21VersionStr} (${pk21.length}B) · NX_BOOT1 (${boot1PinnedMatch ? 'Pinned' : 'Mismatch'}) · KB00 (${kbPinnedMatch ? 'Pinned' : 'Mismatch'}) · STG2 (${stg2Ok ? 'OK' : 'FAIL'})`,
      });

      const fusesOk = prodInfoFuses === 19;
      checks.push({
        id: 'anti-rollback-check',
        category: 'BOOT1',
        label: 'Anti-Rollback Fuse Matrix',
        passed: fusesOk,
        detail: `Burned fuses (${prodInfoFuses}) ${fusesOk ? '==' : '!='} 19 required for FW ${pk21VersionStr}`,
      });
    } catch (err) {
      checks.push({
        id: 'boot1-package2',
        category: 'BOOT1',
        label: 'BOOT1 Package2 PK21 & STG2 SHA-256 Chain',
        passed: false,
        detail: String(err),
      });
    }

    // 6. PRODINFOF: Factory Rail & Battery Fuel-Gauge Calibration
    try {
      const { files } = await this.readPartitionFiles('PRODINFOF');
      const fca = files['/factory/rail_cal.bin'];
      const bat = files['/factory/battery_profile.bin'];
      if (!fca || !bat) throw new Error('Missing factory calibration files');
      const fc = decodeFca0(fca);
      const bt = decodeBat0(bat);
      const ok = fc.railModel.length > 0 && bt.capacityMah > 0;
      checks.push({
        id: 'prodinfof-factory',
        category: 'PRODINFOF',
        label: 'PRODINFOF Factory Calibration (FCA0 & BAT0)',
        passed: ok,
        detail: `Rail ${fc.railModel} (FCA0) and ${bt.model} ${bt.capacityMah}mAh fuel gauge (BAT0) verified`,
      });
    } catch (err) {
      checks.push({
        id: 'prodinfof-factory',
        category: 'PRODINFOF',
        label: 'PRODINFOF Factory Calibration (FCA0 & BAT0)',
        passed: false,
        detail: String(err),
      });
    }

    // 7. BCPKG2: KIP1 Modules Verified Against PK21 Embedded SHA-256 Manifest
    try {
      const { files } = await this.readPartitionFiles('BCPKG2');
      let kipsOk = expectedKipManifest.length === 7;
      let verifiedCount = 0;

      for (const entry of expectedKipManifest) {
        const kBytes = files[`/kip1/${entry.name}`];
        if (!kBytes || kBytes.length !== entry.size) {
          kipsOk = false;
          continue;
        }
        const magic = String.fromCharCode(kBytes[0], kBytes[1], kBytes[2], kBytes[3]);
        if (magic !== 'KIP1' || !bytesEqual(sha256Bytes(kBytes), entry.sha256)) {
          kipsOk = false;
          continue;
        }
        try {
          verifyTrailingCrc32(kBytes, entry.name);
          verifiedCount++;
        } catch {
          kipsOk = false;
        }
      }

      checks.push({
        id: 'bcpkg2-kips',
        category: 'BCPKG2',
        label: 'BCPKG2 KIP1 Modules <-> PK21 SHA-256 Manifest',
        passed: kipsOk,
        detail: `${verifiedCount}/${expectedKipManifest.length} KIP1 binaries match PK21 byte size, CRC32 & SHA-256`,
      });
    } catch (err) {
      checks.push({
        id: 'bcpkg2-kips',
        category: 'BCPKG2',
        label: 'BCPKG2 KIP1 Modules <-> PK21 SHA-256 Manifest',
        passed: false,
        detail: String(err),
      });
    }

    // 8. SAFE: Recovery Mode Binaries
    try {
      const { files } = await this.readPartitionFiles('SAFE');
      const safeBin = files['/safe/recovery.bin'];
      const rfuiBin = files['/safe/recovery_ui.bin'];
      if (!safeBin || !rfuiBin) throw new Error('Missing recovery binaries');
      verifyTrailingCrc32(safeBin, 'SAFE recovery');
      verifyTrailingCrc32(rfuiBin, 'SAFE RFUI');
      const ok =
        textDecoder.decode(safeBin.subarray(0, 4)) === 'SAFE' &&
        textDecoder.decode(rfuiBin.subarray(0, 4)) === 'RFUI';
      checks.push({
        id: 'safe-recovery',
        category: 'SAFE',
        label: 'SAFE Recovery Firmware & Menu Options',
        passed: ok,
        detail: 'Maintenance Mode descriptors (SAFE & RFUI) CRC32 verified',
      });
    } catch (err) {
      checks.push({
        id: 'safe-recovery',
        category: 'SAFE',
        label: 'SAFE Recovery Firmware & Menu Options',
        passed: false,
        detail: String(err),
      });
    }

    // 9. SYSTEM: HOSM, Themes, SFX, QAPP, CAP0, STR0, NRO0, NXVM, ART0/GLY0/SPL0/SPR0, SEQ0 & Game Data
    try {
      const { files } = await this.readPartitionFiles('SYSTEM');
      const hosm = decodeHosm(files['/sys/os_manifest.bin']);
      decodeThm0(files['/sys/themes/basic_white.bin']);
      decodeThm0(files['/sys/themes/basic_black.bin']);
      decodeSfx0(files['/sys/sound/ui_sfx_table.bin']);
      const chime = decodeBootChime(files['/sys/sound/boot_chime.bin']);
      decodeNws0(files['/sys/news/bulletin.bin']);
      decodeEsh0(files['/sys/eshop/catalog.bin']);
      const triviaPkg = decodeQuizPackage(files['/sys/eshop/title-trivia.pkg']);

      const qapp = decodeQapp(files['/sys/applets/qlaunch.bin']);
      const str0 = decodeStr0(files['/sys/locale/strings.bin']);
      const cap0 = decodeCap0(files['/sys/caps/capabilities.bin']);
      const art0 = decodeArtworkPack(files['/sys/assets/artwork_pack.bin']);
      const gly0 = decodeAvatarGlyphs(files['/sys/assets/avatar_glyphs.bin']);
      const spl0 = decodeBootSplash(files['/sys/assets/boot_splash.bin']);
      const spr0 = decodeSpriteAtlas(files['/sys/assets/ui_sprites.bin']);
      const nro0 = decodeQlaunchNro(files['/sys/code/qlaunch.nro']);
      const vmRes = executeBatteryPolicyVm(files['/sys/code/battery_policy.nxb'], {
        [NXVM_REG.BAT_CAPACITY_MAH]: 4310,
        [NXVM_REG.BAT_CYCLES]: 184,
        [NXVM_REG.BAT_RESIST_MOHM]: 42,
        [NXVM_REG.SET_BRIGHTNESS]: 100,
        [NXVM_REG.SET_AIRPLANE]: 0,
        [NXVM_REG.SET_DOCKED]: 0,
        [NXVM_REG.PROD_FUSES]: 19,
      });
      const stlr = decodeStellarData(files['/sys/code/stellar_data.bin']);
      const tet0 = decodeTetrominoData(files['/sys/code/tetromino_data.bin']);
      const chr0 = decodeChromaticData(files['/sys/code/chromatic_data.bin']);

      const homeCapOk = cap0.some((c) => c.titleId === hosm.homeAppletId);
      const verMatch = hosm.osVersion === pk21VersionStr;
      const kernelMatch = parseInt(hosm.kernelEntry, 16) === pk21KernelEntry;
      const qappMatch = qapp.titleId === hosm.homeAppletId && nro0.titleId === hosm.homeAppletId;
      const assetsOk =
        Object.keys(art0).length >= 7 &&
        Object.keys(gly0).length >= 4 &&
        Object.keys(spr0).length >= 3 &&
        Boolean(spl0.dataUrl) &&
        chime.length >= 4 &&
        stlr.pointsPerRock > 0 &&
        tet0.shapes.length >= 4 &&
        chr0.length >= 4 &&
        triviaPkg.questions.length >= 4 &&
        vmRes.instructionsExecuted > 0 &&
        Object.keys(str0).length >= 10;

      checks.push({
        id: 'system-hosm-crosscheck',
        category: 'SYSTEM',
        label: 'SYSTEM HOSM, NRO0, NXVM, ART0/SPR0 & Asset Integrity',
        passed: verMatch && kernelMatch && qappMatch && homeCapOk && assetsOk,
        detail: `HOSM ${hosm.osVersion} == PK21 (${verMatch ? 'OK' : 'FAIL'}) · NRO0/QAPP/CAP0 (${qappMatch && homeCapOk ? 'OK' : 'FAIL'}) · ART0(${Object.keys(art0).length}) SPR0(${Object.keys(spr0).length}) NXVM(${vmRes.instructionsExecuted}ops)`,
      });
    } catch (err) {
      checks.push({
        id: 'system-hosm-crosscheck',
        category: 'SYSTEM',
        label: 'SYSTEM HOSM, NRO0, NXVM, ART0/SPR0 & Asset Integrity',
        passed: false,
        detail: String(err),
      });
    }

    // 10. USER: Settings, Profiles, Album, App Packages & 1:1 Title Registry <-> Save Synchronization
    try {
      const { files } = await this.readPartitionFiles('USER');
      const settings = decodeSet0(files['/user/save/settings.bin']);
      const profiles = decodePrf0(files['/user/save/profiles.bin']);
      const titles = decodeTit0(files['/user/titles/registry.bin']);
      decodeAlb0(files['/user/album/captures.bin']);

      const activeUserOk = profiles.some((p) => p.id === settings.activeUserId);
      let savesOk = true;
      let syncCount = 0;

      for (const t of titles) {
        const sBytes = files[t.saveFilePath];
        if (!sBytes) {
          savesOk = false;
          continue;
        }
        try {
          const s = decodeGameSave(sBytes);
          const scoreMatch =
            t.highScore !== undefined
              ? s.hasHighScore && s.highScore === t.highScore
              : !s.hasHighScore && s.highScore === 0;
          if (!s.valid || s.titleId !== t.id || s.playMinutes !== t.playMinutes || !scoreMatch) {
            savesOk = false;
          } else {
            syncCount++;
          }
          if (t.id === 'title-trivia' && files['/user/apps/title-trivia.pkg']) {
            decodeQuizPackage(files['/user/apps/title-trivia.pkg']);
          }
        } catch {
          savesOk = false;
        }
      }

      checks.push({
        id: 'user-save-sync',
        category: 'USER',
        label: 'USER Profiles, Settings & 1:1 Save Synchronization',
        passed: activeUserOk && savesOk,
        detail: `Active user "${settings.activeUserId}" in PRF0 (${activeUserOk ? 'OK' : 'Missing'}) · ${syncCount}/${titles.length} SAVE files strictly synced with TIT0`,
      });
    } catch (err) {
      checks.push({
        id: 'user-save-sync',
        category: 'USER',
        label: 'USER Profiles, Settings & 1:1 Save Synchronization',
        passed: false,
        detail: String(err),
      });
    }

    const passedCount = checks.filter((c) => c.passed).length;
    return {
      timestamp: Date.now(),
      allPassed: passedCount === checks.length,
      passedCount,
      totalCount: checks.length,
      checks,
    };
  }

  public async corruptChunk(
    partitionId: PartitionId,
    chunkIndex: number
  ): Promise<void> {
    const db = await this.openDb();
    const key = `${partitionId}:${chunkIndex}`;
    const record = await new Promise<NandChunkRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_CHUNKS, 'readonly');
      const req = tx.objectStore(STORE_CHUNKS).get(key);
      req.onsuccess = () => resolve(req.result as NandChunkRecord | undefined);
      req.onerror = () => reject(req.error);
    });

    if (!record) {
      throw new Error(`Chunk ${key} does not exist`);
    }

    const tampered = new Uint8Array(record.data);
    // Flip 16 bytes inside chunk data without updating stored CRC32 -> real hardware bit-rot simulation
    for (let i = 0; i < Math.min(16, tampered.length); i++) {
      tampered[i] = tampered[i] ^ 0xff;
    }

    const updated: NandChunkRecord = {
      ...record,
      data: tampered,
      writtenAt: Date.now(),
    };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_CHUNKS, 'readwrite');
      tx.objectStore(STORE_CHUNKS).put(updated);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    this.emitIo(
      'CORRUPT',
      partitionId,
      `#${chunkIndex}`,
      16,
      false,
      `Injected 16-byte bit-rot into chunk #${chunkIndex} (stored CRC kept stale)`
    );
  }

  public async wipePartitionChunks(partitionId: PartitionId): Promise<void> {
    const db = await this.openDb();
    const keys = await this.getChunkKeysForPartition(db, partitionId);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_CHUNKS, 'readwrite');
      const store = tx.objectStore(STORE_CHUNKS);
      for (const k of keys) store.delete(k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    this.emitIo(
      'CORRUPT',
      partitionId,
      `0..${Math.max(0, keys.length - 1)}`,
      0,
      false,
      `Wiped all ${keys.length} IDB chunks from ${partitionId}`
    );
  }

  public async repairPartition(partitionId: PartitionId): Promise<void> {
    const db = await this.openDb();
    const specs = buildFactoryPartitionSpecs();
    const spec = specs.find((s) => s.id === partitionId);
    if (!spec) throw new Error(`Unknown partition ${partitionId}`);
    const count = await this.writePartitionImageInternal(db, spec, spec.image);
    this.emitIo(
      'FLASH',
      partitionId,
      `0..${count - 1}`,
      spec.image.length,
      true,
      `Repaired ${partitionId} from factory image (${count} chunks)`
    );
  }

  /**
   * Dumps the entire IndexedDB eMMC NAND (all GPT partition metadata + raw Uint8Array chunks)
   * into a single binary container file (`NXND` magic + CRC32 footer) ready to save as rawnand.bin.
   */
  public async exportFullNandBin(): Promise<{
    bytes: Uint8Array;
    partitionCount: number;
    totalBytes: number;
  }> {
    const partitions = await this.listPartitions();
    const requiredMap: Record<NandPartitionMeta['requiredBy'], number> = {
      STAGE1: 0,
      STAGE2: 1,
      OS_HOME: 2,
    };

    const w = new BinaryWriter(256 * 1024);
    w.writeMagic('NXND');
    w.writeU32(1); // dump format version
    w.writeF64(Date.now());
    w.writeU32(partitions.length);

    for (const meta of partitions) {
      const chunks = await this.getPartitionChunkRecords(meta.id);
      const rawImage = reassembleChunks(chunks.map((c) => c.data));

      w.writeFixedString(meta.id, 16);
      w.writeU8(meta.gptIndex);
      w.writeU8(meta.encrypted ? 1 : 0);
      w.writeU8(requiredMap[meta.requiredBy] ?? 2);
      w.writeF64(meta.virtualCapacityBytes);
      w.writeU32(meta.startLba);
      w.writeU32(meta.endLba);
      w.writeVarString(meta.label);
      w.writeVarString(meta.description);
      w.writeU32(rawImage.length);
      w.writeBytes(rawImage);

      this.emitIo(
        'READ',
        meta.id,
        `0..${Math.max(0, chunks.length - 1)}`,
        rawImage.length,
        true,
        `Exported ${meta.id} (${rawImage.length} B) into rawnand.bin`
      );
    }

    const bytes = w.finishWithCrc32();
    return {
      bytes,
      partitionCount: partitions.length,
      totalBytes: bytes.length,
    };
  }

  /**
   * Verifies and restores an entire raw NAND `.bin` backup (`NXND` format)
   * back into chunked 16 KiB Uint8Array blocks inside IndexedDB.
   */
  public async importFullNandBin(fileBytes: Uint8Array): Promise<{
    partitionCount: number;
    totalBytesRestored: number;
  }> {
    verifyTrailingCrc32(fileBytes, 'rawnand.bin (NXND)');
    const r = new BinaryReader(fileBytes);
    const magic = r.readMagic(4);
    if (magic !== 'NXND') {
      throw new Error(`Invalid NAND backup file magic "${magic}" (expected "NXND")`);
    }
    const version = r.readU32();
    if (version !== 1) {
      throw new Error(`Unsupported NXND backup version ${version}`);
    }
    r.readF64(); // dump timestamp
    const partitionCount = r.readU32();
    if (partitionCount === 0 || partitionCount > 32) {
      throw new Error(`Invalid partition count (${partitionCount}) in NAND backup`);
    }

    const requiredRev: NandPartitionMeta['requiredBy'][] = [
      'STAGE1',
      'STAGE2',
      'OS_HOME',
    ];

    const parsed: Array<{
      spec: Omit<FactoryPartitionSpec, 'image'>;
      image: Uint8Array;
    }> = [];

    for (let i = 0; i < partitionCount; i++) {
      const id = r.readFixedString(16) as PartitionId;
      const gptIndex = r.readU8();
      const encrypted = r.readU8() === 1;
      const reqIdx = r.readU8();
      const virtualCapacityBytes = r.readF64();
      const startLba = r.readU32();
      const endLba = r.readU32();
      const label = r.readVarString();
      const description = r.readVarString();
      const rawLen = r.readU32();
      if (endLba < startLba || rawLen > virtualCapacityBytes) {
        throw new Error(`Invalid GPT/size metadata for partition ${id}`);
      }
      const image = r.readBytes(rawLen);

      parsed.push({
        spec: {
          id,
          gptIndex,
          label,
          description,
          requiredBy: requiredRev[reqIdx] ?? 'OS_HOME',
          virtualCapacityBytes,
          encrypted,
          startLba,
          endLba,
        },
        image,
      });
    }

    if (r.pos !== fileBytes.length - 4) {
      throw new Error(
        `NXND container trailing garbage detected (parsed ${r.pos}, expected ${fileBytes.length - 4})`
      );
    }

    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_GPT, STORE_CHUNKS], 'readwrite');
      tx.objectStore(STORE_GPT).clear();
      tx.objectStore(STORE_CHUNKS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    let totalBytesRestored = 0;
    for (const entry of parsed) {
      const count = await this.writePartitionImageInternal(
        db,
        entry.spec,
        entry.image
      );
      totalBytesRestored += entry.image.length;
      this.emitIo(
        'FLASH',
        entry.spec.id,
        `0..${Math.max(0, count - 1)}`,
        entry.image.length,
        true,
        `Restored ${entry.spec.id} (${count} chunks) from rawnand.bin`
      );
    }

    return { partitionCount, totalBytesRestored };
  }
}

export const nandStore = new NandChunkStore();
