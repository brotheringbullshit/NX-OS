import {
  BinaryReader,
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
} from '../nand/binaryStructs';
import { bytesEqual, bytesToHex, crc32, formatHex32, sha256Bytes } from '../nand/crc32';
import { nandStore } from '../nand/nandChunkStore';
import {
  decodeGameSave,
  decodeKeyblobBinary,
  getMasterKeyHashHex,
} from '../nand/nandFactoryImage';
import {
  AlbumCapture,
  BatteryProfile,
  BootChimeNote,
  BootedSystemContext,
  BootFailure,
  BootLogLine,
  BootSplashAsset,
  ChromaticPadDef,
  ConsoleSettings,
  EshopListing,
  HardwareCalibration,
  InstalledTitle,
  NewsArticle,
  NroProgramHeader,
  PartitionId,
  ProdInfoPayload,
  QlaunchConfig,
  QuizPackage,
  SpriteBitmap,
  StellarGameConfig,
  SwitchThemeTokens,
  SystemCapability,
  SystemOsManifest,
  TetrominoGameConfig,
  UiSfxTable,
  UserProfile,
} from '../nand/nandTypes';
import { executeBatteryPolicyVm, NXVM_REG } from '../nand/nxVm';
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
} from '../nand/systemAssets';

export interface BootCallbacks {
  onStageChange: (stage: 'PROVISIONING' | 'STAGE1' | 'STAGE2' | 'SPLASH') => void;
  onLog: (line: BootLogLine) => void;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const decoder = new TextDecoder();

function makeFailure(
  stage: BootFailure['stage'],
  code: string,
  title: string,
  partition: PartitionId,
  reason: string,
  logs: BootLogLine[]
): BootFailure {
  return { stage, code, title, partition, reason, logs };
}

function readFixedAscii(buf: Uint8Array, offset: number, width: number): string {
  const slice = buf.subarray(offset, offset + width);
  const z = slice.indexOf(0);
  return decoder.decode(z >= 0 ? slice.subarray(0, z) : slice).trim();
}

export async function runConsoleBootSequence(
  callbacks: BootCallbacks,
  options: { fastBoot?: boolean } = {}
): Promise<BootedSystemContext> {
  const startTime = performance.now();
  const logs: BootLogLine[] = [];
  let totalChunksRead = 0;
  let totalBytesRead = 0;

  const stepDelay = options.fastBoot ? 30 : 85;

  const pushLog = (line: BootLogLine) => {
    logs.push(line);
    callbacks.onLog(line);
  };

  // Step 0: Check IndexedDB NAND provisioning
  const provisionedNow = !(await nandStore.isProvisioned());
  if (provisionedNow) {
    callbacks.onStageChange('PROVISIONING');
    pushLog({
      stage: 'ROM',
      level: 'WARN',
      text: 'Uninitialized eMMC detected in IndexedDB (nx_nand_emmc_v1). Flashing binary GPT & 16 KiB Uint8Array chunks...',
    });
    await nandStore.ensureProvisioned((pid, chunks) => {
      pushLog({
        stage: 'ROM',
        level: 'OK',
        partition: pid,
        chunkInfo: `${chunks} chunks`,
        text: `Flashed ${pid} -> ${chunks} binary Uint8Array blocks committed to IndexedDB`,
      });
    });
    await pause(stepDelay);
  }

  // =========================================================================
  // STAGE 1 BOOTLOADER (BOOT0 -> BCT0 + STG1 + NX_BOOT1 -> PRODINFO CAL0/KB00)
  // =========================================================================
  callbacks.onStageChange('STAGE1');
  pushLog({
    stage: 'ROM',
    level: 'INFO',
    text: 'BootROM cold reset vector -> mounting eMMC BOOT0 via IndexedDB block bus',
  });
  await pause(stepDelay);

  let boot0Files: Record<string, Uint8Array>;
  try {
    const res = await nandStore.readPartitionFiles('BOOT0');
    boot0Files = res.files;
    totalChunksRead += res.chunks.length;
    totalBytesRead += res.meta.usedBytes;
    pushLog({
      stage: 'STAGE1',
      level: 'OK',
      partition: 'BOOT0',
      chunkInfo: `${res.chunks.length} chunks`,
      text: `BOOT0 read (${res.meta.usedBytes} B across ${res.chunks.length} IDB chunks), CRC32 ${formatHex32(res.meta.partitionCrc32)}`,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Failed to read BOOT0';
    pushLog({ stage: 'STAGE1', level: 'ERR', partition: 'BOOT0', text: reason });
    throw makeFailure(
      'STAGE1',
      'ERR-BOOT0-NXFS',
      'Stage 1 Bootloader Fault (BOOT0)',
      'BOOT0',
      reason,
      logs
    );
  }

  // Verify BCT0 magic & CRC inside BOOT0
  const bct = boot0Files['/boot/bct.bin'];
  if (!bct || bct.length < 1024) {
    const reason = 'Missing or truncated /boot/bct.bin inside BOOT0';
    pushLog({ stage: 'STAGE1', level: 'ERR', partition: 'BOOT0', text: reason });
    throw makeFailure('STAGE1', 'ERR-BCT0-MISSING', 'Missing Boot Config Table', 'BOOT0', reason, logs);
  }
  const bctMagic = String.fromCharCode(bct[0], bct[1], bct[2], bct[3]);
  const bctView = new DataView(bct.buffer, bct.byteOffset, bct.byteLength);
  const bctCrcStored = bctView.getUint32(1020, true);
  const bctCrcActual = crc32(bct.subarray(0, 1020));
  if (bctMagic !== 'BCT0' || bctCrcStored !== bctCrcActual) {
    const reason = `BCT0 verification failed (magic=${bctMagic}, CRC=${formatHex32(bctCrcActual)})`;
    pushLog({ stage: 'STAGE1', level: 'ERR', partition: 'BOOT0', text: reason });
    throw makeFailure('STAGE1', 'ERR-BCT0-CRC', 'BCT0 Calibration Corrupt', 'BOOT0', reason, logs);
  }
  const bctEntryPoint = bctView.getUint32(0x08, true);
  const bctStage1Size = bctView.getUint32(0x10, true);
  const dramMhz = bctView.getUint32(0x14, true);
  const bctSerial = readFixedAscii(bct, 0x20, 32);
  const bctKeyblobSha256 = bct.subarray(0x100, 0x120);
  const bctBoot1Sha256 = bct.subarray(0x120, 0x140);

  pushLog({
    stage: 'STAGE1',
    level: 'OK',
    partition: 'BOOT0',
    text: `BCT0 verified: LPDDR4 initialized @ ${dramMhz} MHz · Target IRAM ${formatHex32(bctEntryPoint)}`,
  });
  await pause(stepDelay);

  // Verify NX_BOOT1 binary + STG1 header inside BOOT0 against BCT0 digests
  const nxBoot1 = boot0Files['/boot/nx_boot1.bin'];
  const stg1Hdr = boot0Files['/boot/stage1.hdr'];
  if (!nxBoot1 || nxBoot1.length < 116 || !stg1Hdr) {
    const reason = 'Missing /boot/nx_boot1.bin or /boot/stage1.hdr payload';
    pushLog({ stage: 'STAGE1', level: 'ERR', partition: 'BOOT0', text: reason });
    throw makeFailure('STAGE1', 'ERR-BOOT1-BIN', 'Stage 1 Payload Missing', 'BOOT0', reason, logs);
  }

  const boot1Sig = decoder.decode(nxBoot1.subarray(0, 8));
  if (boot1Sig !== 'NX_BOOT1') {
    const reason = `Invalid Stage 1 signature "${boot1Sig}"`;
    pushLog({ stage: 'STAGE1', level: 'ERR', partition: 'BOOT0', text: reason });
    throw makeFailure('STAGE1', 'ERR-BOOT1-SIG', 'Invalid Stage 1 Signature', 'BOOT0', reason, logs);
  }
  const boot1View = new DataView(nxBoot1.buffer, nxBoot1.byteOffset, nxBoot1.byteLength);
  const boot1CrcStored = boot1View.getUint32(nxBoot1.length - 4, true);
  const boot1CrcActual = crc32(nxBoot1.subarray(0, nxBoot1.length - 4));
  if (boot1CrcStored !== boot1CrcActual) {
    const reason = 'NX_BOOT1 binary CRC32 mismatch';
    pushLog({ stage: 'STAGE1', level: 'ERR', partition: 'BOOT0', text: reason });
    throw makeFailure('STAGE1', 'ERR-BOOT1-CRC', 'Stage 1 Binary Corrupt', 'BOOT0', reason, logs);
  }

  // Cross-check: BCT0 Stage 1 size, SHA-256 digest & entry point vector
  if (nxBoot1.length !== bctStage1Size) {
    const reason = `NX_BOOT1 byte length (${nxBoot1.length}) != BCT0 Stage 1 size (${bctStage1Size})`;
    pushLog({ stage: 'STAGE1', level: 'ERR', partition: 'BOOT0', text: reason });
    throw makeFailure('STAGE1', 'ERR-BOOT1-SIZE', 'Stage 1 Size Mismatch', 'BOOT0', reason, logs);
  }

  const actualBoot1Sha256 = sha256Bytes(nxBoot1);
  if (!bytesEqual(actualBoot1Sha256, bctBoot1Sha256)) {
    const reason = `NX_BOOT1 SHA-256 mismatch against BCT0 root digest`;
    pushLog({ stage: 'STAGE1', level: 'ERR', partition: 'BOOT0', text: reason });
    throw makeFailure('STAGE1', 'ERR-BOOT1-HASH', 'Stage 1 SHA-256 Mismatch', 'BOOT0', reason, logs);
  }

  const boot1EntryPointVal = boot1View.getUint32(8, true);
  if (bctEntryPoint !== boot1EntryPointVal) {
    const reason = `Stage 1 entry vector mismatch: BCT0 (${formatHex32(bctEntryPoint)}) != NX_BOOT1 (${formatHex32(boot1EntryPointVal)})`;
    pushLog({ stage: 'STAGE1', level: 'ERR', partition: 'BOOT0', text: reason });
    throw makeFailure('STAGE1', 'ERR-BCT-VECTOR-MISMATCH', 'Stage 1 Vector Mismatch', 'BOOT0', reason, logs);
  }

  // Verify STG1 descriptor matches NX_BOOT1
  try {
    verifyTrailingCrc32(stg1Hdr, 'BOOT0 STG1');
    const sr = new BinaryReader(stg1Hdr);
    const stg1Magic = sr.readMagic(4);
    const stg1Num = sr.readU8();
    sr.readU8(); // dram init
    sr.readU16(); // bct ver
    const stg1Entry = sr.readU32();
    const stg1Target = sr.readFixedString(16);
    const stg1Size = sr.readU32();
    const stg1Sha256 = sr.readBytes(32);
    if (
      stg1Magic !== 'STG1' ||
      stg1Num !== 1 ||
      stg1Entry !== bctEntryPoint ||
      stg1Target !== 'BOOT1' ||
      stg1Size !== nxBoot1.length ||
      !bytesEqual(stg1Sha256, actualBoot1Sha256)
    ) {
      throw new Error('STG1 header descriptor out of sync with BCT0 / NX_BOOT1');
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'STG1 verification failed';
    pushLog({ stage: 'STAGE1', level: 'ERR', partition: 'BOOT0', text: reason });
    throw makeFailure('STAGE1', 'ERR-STG1-HDR', 'Stage 1 Header Fault', 'BOOT0', reason, logs);
  }

  // Extract NX_BOOT1's pinned Stage 2 (Package2) coordinates & SHA-256
  const nxBoot1Stage2Part = readFixedAscii(nxBoot1, 0x18, 16);
  const nxBoot1Stage2Path = readFixedAscii(nxBoot1, 0x28, 32);
  const nxBoot1Stage2Addr = boot1View.getUint32(0x48, true);
  const nxBoot1Stage2Size = boot1View.getUint32(0x4c, true);
  const nxBoot1Stage2Sha256 = nxBoot1.subarray(0x50, 0x70);

  const entryPoint = formatHex32(boot1EntryPointVal);
  pushLog({
    stage: 'STAGE1',
    level: 'INFO',
    partition: 'BOOT0',
    text: `Executing NX_BOOT1 @ IRAM ${entryPoint} (SHA-256 ${bytesToHex(actualBoot1Sha256.subarray(0, 6))}…) -> verifying PRODINFO`,
  });
  await pause(stepDelay);

  // Stage 1 reads binary PRODINFO (/cal/prodinfo.bin, /cal/cal0_keyblob.bin, sensor cal)
  let prodInfo: ProdInfoPayload;
  let kbPkg2Sha256: Uint8Array;
  let touchCal: HardwareCalibration['touch'];
  let audioCal: HardwareCalibration['audio'];
  let imuCal: HardwareCalibration['imu'];
  try {
    const res = await nandStore.readPartitionFiles('PRODINFO');
    totalChunksRead += res.chunks.length;
    totalBytesRead += res.meta.usedBytes;
    const calBytes = res.files['/cal/prodinfo.bin'];
    const kbBytes = res.files['/cal/cal0_keyblob.bin'];
    const tcalBytes = res.files['/cal/touch_cal.bin'];
    const acalBytes = res.files['/cal/audio_cal.bin'];
    const icalBytes = res.files['/cal/imu_cal.bin'];

    if (!calBytes || !kbBytes || !tcalBytes || !acalBytes || !icalBytes) {
      throw new Error('Missing required calibration binaries inside PRODINFO');
    }

    prodInfo = decodeCal0(calBytes);

    // Cross-check: Hardware Identity Consistency (BCT0 serial vs CAL0 serial)
    if (bctSerial && prodInfo.serial && bctSerial !== prodInfo.serial) {
      throw new Error(`Hardware serial mismatch: BCT0 (${bctSerial}) vs PRODINFO (${prodInfo.serial})`);
    }

    // Cross-check: Hardware Anti-Rollback Fuses (FW 18.1.0 requires 19 fuses)
    const expectedFuses = 19;
    if (prodInfo.fuseCount < expectedFuses) {
      throw new Error(`Anti-rollback violation: burned fuses (${prodInfo.fuseCount}) < required (${expectedFuses})`);
    } else if (prodInfo.fuseCount > expectedFuses) {
      throw new Error(`Firmware revocation: burned fuses (${prodInfo.fuseCount}) > FW 18.1.0 limit (${expectedFuses})`);
    }

    // Verify KB00 cryptographic store against BCT0, CAL0 masterKeyHash, and NX_BOOT1
    const kb = decodeKeyblobBinary(kbBytes);
    const actualKbSha256 = sha256Bytes(kbBytes);
    if (!bytesEqual(actualKbSha256, bctKeyblobSha256)) {
      throw new Error('PRODINFO KB00 SHA-256 mismatch against BCT0 keyblob digest');
    }
    const expectedKeyHex = getMasterKeyHashHex(prodInfo.fuseCount - 1);
    if (prodInfo.masterKeyHash !== expectedKeyHex) {
      throw new Error(`CAL0 masterKeyHash (${prodInfo.masterKeyHash}) != Rev 18 digest (${expectedKeyHex})`);
    }
    if (!bytesEqual(kb.pkg1Sha256, actualBoot1Sha256)) {
      throw new Error('PRODINFO KB00 Package1 SHA-256 mismatch against NX_BOOT1');
    }
    kbPkg2Sha256 = kb.pkg2Sha256;

    // Decode & verify hardware sensor calibration files
    touchCal = decodeTcal(tcalBytes);
    audioCal = decodeAcal(acalBytes);
    imuCal = decodeIcal(icalBytes);

    pushLog({
      stage: 'STAGE1',
      level: 'OK',
      partition: 'PRODINFO',
      chunkInfo: `${res.chunks.length} chunks`,
      text: `PRODINFO CAL0/KB00 OK -> Serial ${prodInfo.serial} · Region ${prodInfo.region} · Fuses ${prodInfo.fuseCount}/19 · Keyblob SHA-256 verified`,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'PRODINFO calibration fault';
    pushLog({ stage: 'STAGE1', level: 'ERR', partition: 'PRODINFO', text: reason });
    const code = reason.includes('Anti-rollback')
      ? 'ERR-ANTIROLLBACK-PANIC'
      : reason.includes('revocation')
        ? 'ERR-DOWNGRADE-PANIC'
        : reason.includes('serial mismatch')
          ? 'ERR-SERIAL-MISMATCH'
          : 'ERR-PRODINFO-CAL0';
    throw makeFailure(
      'STAGE1',
      code,
      'Console Calibration Partition Fault',
      'PRODINFO',
      reason,
      logs
    );
  }
  await pause(stepDelay);

  // =========================================================================
  // STAGE 2 BOOTLOADER (BOOT1/PK21 -> PRODINFOF -> BCPKG2 KIP1 -> SAFE)
  // =========================================================================
  callbacks.onStageChange('STAGE2');
  pushLog({
    stage: 'STAGE1',
    level: 'INFO',
    text: `Stage 1 handoff -> loading Stage 2 (${nxBoot1Stage2Part}:${nxBoot1Stage2Path})`,
  });
  await pause(stepDelay);

  let pkKernelEntry = 0x80000000;
  let pkVersionStr = '18.1.0';
  const expectedKipManifest: Array<{ name: string; size: number; sha256: Uint8Array }> = [];

  try {
    if (nxBoot1Stage2Part !== 'BOOT1') {
      throw new Error(`Unexpected Stage 2 target partition "${nxBoot1Stage2Part}"`);
    }
    const res = await nandStore.readPartitionFiles('BOOT1');
    totalChunksRead += res.chunks.length;
    totalBytesRead += res.meta.usedBytes;
    const pk21 = res.files[nxBoot1Stage2Path] ?? res.files['/pk21/package2.bin'];
    const stg2Hdr = res.files['/pk21/stage2.hdr'];
    if (!pk21 || pk21.length < 400 || !stg2Hdr) {
      throw new Error('Missing /pk21/package2.bin or /pk21/stage2.hdr inside BOOT1');
    }
    const pkMagic = String.fromCharCode(pk21[0], pk21[1], pk21[2], pk21[3]);
    if (pkMagic !== 'PK21') {
      throw new Error(`Invalid Stage 2 package magic "${pkMagic}"`);
    }
    verifyTrailingCrc32(pk21, 'BOOT1 PK21');

    // Cross-check Package2 size & SHA-256 against Stage 1 (NX_BOOT1) and KB00
    if (pk21.length !== nxBoot1Stage2Size) {
      throw new Error(`PK21 size (${pk21.length}) != NX_BOOT1 expected size (${nxBoot1Stage2Size})`);
    }
    const actualPk21Sha256 = sha256Bytes(pk21);
    if (!bytesEqual(actualPk21Sha256, nxBoot1Stage2Sha256)) {
      throw new Error('PK21 SHA-256 mismatch against NX_BOOT1 Stage 2 digest');
    }
    if (!bytesEqual(actualPk21Sha256, kbPkg2Sha256)) {
      throw new Error('PK21 SHA-256 mismatch against PRODINFO KB00 Package2 digest');
    }

    const pkView = new DataView(pk21.buffer, pk21.byteOffset, pk21.byteLength);
    pkKernelEntry = pkView.getUint32(4, true);
    if (pkKernelEntry !== nxBoot1Stage2Addr) {
      throw new Error(`PK21 kernel entry (${formatHex32(pkKernelEntry)}) != NX_BOOT1 target (${formatHex32(nxBoot1Stage2Addr)})`);
    }
    const pkVer = pkView.getUint32(8, true);
    const maj = (pkVer >> 16) & 0xff;
    const min = (pkVer >> 8) & 0xff;
    const pat = pkVer & 0xff;
    pkVersionStr = `${maj}.${min}.${pat}`;
    const kipCount = pkView.getUint32(0x0c, true);
    if (kipCount !== 7) {
      throw new Error(`Unexpected PK21 KIP1 count (${kipCount}, expected 7)`);
    }

    // Verify STG2 header aligns with PK21
    verifyTrailingCrc32(stg2Hdr, 'BOOT1 STG2');
    const sr2 = new BinaryReader(stg2Hdr);
    const stg2Magic = sr2.readMagic(4);
    const stg2Num = sr2.readU8();
    const stg2KipCount = sr2.readU8();
    sr2.readU16();
    const stg2Entry = sr2.readU32();
    const stg2Tag = sr2.readFixedString(8);
    const stg2Size = sr2.readU32();
    const stg2Sha256 = sr2.readBytes(32);
    if (
      stg2Magic !== 'STG2' ||
      stg2Num !== 2 ||
      stg2KipCount !== kipCount ||
      stg2Entry !== pkKernelEntry ||
      stg2Tag !== 'PK21' ||
      stg2Size !== pk21.length ||
      !bytesEqual(stg2Sha256, actualPk21Sha256)
    ) {
      throw new Error('STG2 header descriptor out of sync with PK21');
    }

    // Read pinned KIP1 SHA-256 manifest from PK21 offset 0x30
    const mr = new BinaryReader(pk21);
    mr.pos = 0x30;
    for (let i = 0; i < kipCount; i++) {
      const name = mr.readFixedString(16);
      const size = mr.readU32();
      const sha256 = mr.readBytes(32);
      expectedKipManifest.push({ name, size, sha256 });
    }

    pushLog({
      stage: 'STAGE2',
      level: 'OK',
      partition: 'BOOT1',
      chunkInfo: `${res.chunks.length} chunks`,
      text: `Stage 2 PK21 verified (SHA-256 ${bytesToHex(actualPk21Sha256.subarray(0, 6))}…) -> Kernel ${pkVersionStr} @ ${formatHex32(pkKernelEntry)}`,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Stage 2 PK21 fault';
    pushLog({ stage: 'STAGE2', level: 'ERR', partition: 'BOOT1', text: reason });
    throw makeFailure(
      'STAGE2',
      'ERR-PK21-STAGE2',
      'Stage 2 Bootloader Fault (BOOT1)',
      'BOOT1',
      reason,
      logs
    );
  }
  await pause(stepDelay);

  // Stage 2 verifies PRODINFOF factory telemetry & battery fuel gauge
  let railModel: string;
  let batteryProfile: BatteryProfile;
  try {
    const res = await nandStore.readPartitionFiles('PRODINFOF');
    totalChunksRead += res.chunks.length;
    totalBytesRead += res.meta.usedBytes;
    const fcaBytes = res.files['/factory/rail_cal.bin'];
    const batBytes = res.files['/factory/battery_profile.bin'];
    if (!fcaBytes || !batBytes) {
      throw new Error('Missing /factory/rail_cal.bin or /factory/battery_profile.bin in PRODINFOF');
    }
    const fca = decodeFca0(fcaBytes);
    batteryProfile = decodeBat0(batBytes);
    railModel = fca.railModel;

    pushLog({
      stage: 'STAGE2',
      level: 'OK',
      partition: 'PRODINFOF',
      chunkInfo: `${res.chunks.length} chunks`,
      text: `PRODINFOF verified (${fca.railModel} rail & ${batteryProfile.model} ${batteryProfile.capacityMah}mAh fuel gauge)`,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'PRODINFOF fault';
    pushLog({ stage: 'STAGE2', level: 'ERR', partition: 'PRODINFOF', text: reason });
    throw makeFailure(
      'STAGE2',
      'ERR-PRODINFOF-CAL',
      'Factory Calibration Fault (PRODINFOF)',
      'PRODINFOF',
      reason,
      logs
    );
  }

  // Stage 2 loads & cryptographically verifies KIP1 modules from BCPKG2 against PK21 manifest
  const kipsLoaded: string[] = [];
  try {
    const res = await nandStore.readPartitionFiles('BCPKG2');
    totalChunksRead += res.chunks.length;
    totalBytesRead += res.meta.usedBytes;

    for (const entry of expectedKipManifest) {
      const kipBytes = res.files[`/kip1/${entry.name}`];
      if (!kipBytes || kipBytes.length < 64) {
        throw new Error(`Missing kernel module /kip1/${entry.name} in BCPKG2`);
      }
      const magic = String.fromCharCode(kipBytes[0], kipBytes[1], kipBytes[2], kipBytes[3]);
      if (magic !== 'KIP1') {
        throw new Error(`Invalid KIP1 header on ${entry.name}`);
      }
      verifyTrailingCrc32(kipBytes, `KIP1 ${entry.name}`);
      if (kipBytes.length !== entry.size) {
        throw new Error(`KIP1 ${entry.name} byte length (${kipBytes.length}) != PK21 manifest (${entry.size})`);
      }
      if (!bytesEqual(sha256Bytes(kipBytes), entry.sha256)) {
        throw new Error(`KIP1 ${entry.name} SHA-256 digest mismatch against PK21 manifest`);
      }
      kipsLoaded.push(entry.name);
    }

    pushLog({
      stage: 'KERNEL',
      level: 'OK',
      partition: 'BCPKG2',
      chunkInfo: `${res.chunks.length} chunks`,
      text: `Loaded & SHA-256 verified ${kipsLoaded.length} KIP1 modules (${kipsLoaded.join(', ')})`,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'BCPKG2 KIP1 load error';
    pushLog({ stage: 'KERNEL', level: 'ERR', partition: 'BCPKG2', text: reason });
    throw makeFailure(
      'STAGE2',
      'ERR-BCPKG2-KIP1',
      'Kernel Initial Process Fault (BCPKG2)',
      'BCPKG2',
      reason,
      logs
    );
  }

  // Stage 2 verifies SAFE maintenance recovery partition
  try {
    const res = await nandStore.readPartitionFiles('SAFE');
    totalChunksRead += res.chunks.length;
    totalBytesRead += res.meta.usedBytes;
    const safeBytes = res.files['/safe/recovery.bin'];
    const rfuiBytes = res.files['/safe/recovery_ui.bin'];
    if (!safeBytes || !rfuiBytes) {
      throw new Error('Missing /safe/recovery.bin or /safe/recovery_ui.bin inside SAFE');
    }
    verifyTrailingCrc32(safeBytes, 'SAFE recovery');
    verifyTrailingCrc32(rfuiBytes, 'SAFE RFUI');
    if (decoder.decode(safeBytes.subarray(0, 4)) !== 'SAFE') throw new Error('Invalid SAFE magic');
    if (decoder.decode(rfuiBytes.subarray(0, 4)) !== 'RFUI') throw new Error('Invalid RFUI magic');

    pushLog({
      stage: 'STAGE2',
      level: 'OK',
      partition: 'SAFE',
      chunkInfo: `${res.chunks.length} chunks`,
      text: 'SAFE recovery partition verified (SAFE & RFUI descriptors)',
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'SAFE recovery verification fault';
    pushLog({ stage: 'STAGE2', level: 'ERR', partition: 'SAFE', text: reason });
    throw makeFailure(
      'STAGE2',
      'ERR-SAFE-RECOVERY',
      'Recovery Partition Fault (SAFE)',
      'SAFE',
      reason,
      logs
    );
  }
  await pause(stepDelay);

  // =========================================================================
  // HORIZON OS MOUNT (SYSTEM + USER PARTITIONS -> qlaunch HOME Menu)
  // =========================================================================
  let osManifest: SystemOsManifest;
  let lightTheme: SwitchThemeTokens;
  let darkTheme: SwitchThemeTokens;
  let sfxTable: UiSfxTable;
  let news: NewsArticle[];
  let eshopCatalog: EshopListing[];
  let localeStrings: Record<string, string>;
  let qlaunchConfig: QlaunchConfig;
  let capabilities: SystemCapability[];
  let artworkImages: Record<string, string>;
  let avatarGlyphs: Record<string, string>;
  let bootSplash: BootSplashAsset;
  let spriteAtlas: Record<string, SpriteBitmap>;
  let bootChime: BootChimeNote[];
  let stellarConfig: StellarGameConfig;
  let tetrominoConfig: TetrominoGameConfig;
  let chromaticPads: ChromaticPadDef[];
  let qlaunchNro: NroProgramHeader;
  let batteryPolicyVmBytes: Uint8Array;
  let defaultQuizPackage: QuizPackage;

  try {
    const res = await nandStore.readPartitionFiles('SYSTEM');
    totalChunksRead += res.chunks.length;
    totalBytesRead += res.meta.usedBytes;

    const hosmBytes = res.files['/sys/os_manifest.bin'];
    const whiteBytes = res.files['/sys/themes/basic_white.bin'];
    const blackBytes = res.files['/sys/themes/basic_black.bin'];
    const sfxBytes = res.files['/sys/sound/ui_sfx_table.bin'];
    const chimeBytes = res.files['/sys/sound/boot_chime.bin'];
    const qappBytes = res.files['/sys/applets/qlaunch.bin'];
    const newsBytes = res.files['/sys/news/bulletin.bin'];
    const eshopBytes = res.files['/sys/eshop/catalog.bin'];
    const triviaPkgBytes = res.files['/sys/eshop/title-trivia.pkg'];
    const strBytes = res.files['/sys/locale/strings.bin'];
    const capBytes = res.files['/sys/caps/capabilities.bin'];
    const artBytes = res.files['/sys/assets/artwork_pack.bin'];
    const glyBytes = res.files['/sys/assets/avatar_glyphs.bin'];
    const splBytes = res.files['/sys/assets/boot_splash.bin'];
    const sprBytes = res.files['/sys/assets/ui_sprites.bin'];
    const nroBytes = res.files['/sys/code/qlaunch.nro'];
    const vmBytes = res.files['/sys/code/battery_policy.nxb'];
    const stlrBytes = res.files['/sys/code/stellar_data.bin'];
    const tetBytes = res.files['/sys/code/tetromino_data.bin'];
    const chrBytes = res.files['/sys/code/chromatic_data.bin'];

    if (
      !hosmBytes ||
      !whiteBytes ||
      !blackBytes ||
      !sfxBytes ||
      !chimeBytes ||
      !qappBytes ||
      !newsBytes ||
      !eshopBytes ||
      !triviaPkgBytes ||
      !strBytes ||
      !capBytes ||
      !artBytes ||
      !glyBytes ||
      !splBytes ||
      !sprBytes ||
      !nroBytes ||
      !vmBytes ||
      !stlrBytes ||
      !tetBytes ||
      !chrBytes
    ) {
      throw new Error('Missing required binary system, code, or asset files inside SYSTEM partition');
    }

    osManifest = decodeHosm(hosmBytes);

    // Cross-check: SYSTEM HOSM manifest consistency with Package2 kernel & BCPKG2
    if (osManifest.osVersion !== pkVersionStr) {
      throw new Error(`OS manifest version (${osManifest.osVersion}) mismatch with Package2 kernel (${pkVersionStr})`);
    }
    if (parseInt(osManifest.kernelEntry, 16) !== pkKernelEntry) {
      throw new Error(`OS manifest kernel entry (${osManifest.kernelEntry}) mismatch with Package2 (${formatHex32(pkKernelEntry)})`);
    }
    for (const reqKip of osManifest.requiredKips) {
      if (!kipsLoaded.includes(reqKip)) {
        throw new Error(`HOSM required KIP "${reqKip}" not loaded from BCPKG2`);
      }
    }

    // Verify QAPP, STR0, CAP0, and NRO0 consistency
    qlaunchConfig = decodeQapp(qappBytes);
    if (qlaunchConfig.titleId !== osManifest.homeAppletId) {
      throw new Error(`QAPP titleId (${qlaunchConfig.titleId}) != HOSM homeAppletId (${osManifest.homeAppletId})`);
    }
    localeStrings = decodeStr0(strBytes);
    capabilities = decodeCap0(capBytes);
    if (!capabilities.some((c) => c.titleId === osManifest.homeAppletId)) {
      throw new Error(`Home applet (${osManifest.homeAppletId}) missing from SYSTEM CAP0 capabilities`);
    }

    qlaunchNro = decodeQlaunchNro(nroBytes);
    if (qlaunchNro.titleId !== osManifest.homeAppletId) {
      throw new Error(`NRO0 titleId (${qlaunchNro.titleId}) != HOSM homeAppletId (${osManifest.homeAppletId})`);
    }

    lightTheme = decodeThm0(whiteBytes);
    darkTheme = decodeThm0(blackBytes);
    sfxTable = decodeSfx0(sfxBytes);
    bootChime = decodeBootChime(chimeBytes);
    news = decodeNws0(newsBytes);
    eshopCatalog = decodeEsh0(eshopBytes);
    artworkImages = decodeArtworkPack(artBytes);
    avatarGlyphs = decodeAvatarGlyphs(glyBytes);
    bootSplash = decodeBootSplash(splBytes);
    spriteAtlas = decodeSpriteAtlas(sprBytes);
    stellarConfig = decodeStellarData(stlrBytes);
    tetrominoConfig = decodeTetrominoData(tetBytes);
    chromaticPads = decodeChromaticData(chrBytes);
    defaultQuizPackage = decodeQuizPackage(triviaPkgBytes);
    batteryPolicyVmBytes = vmBytes;

    pushLog({
      stage: 'HOS',
      level: 'OK',
      partition: 'SYSTEM',
      chunkInfo: `${res.chunks.length} chunks`,
      text: `Mounted SYSTEM (${osManifest.codename} ${osManifest.osVersion}) -> NRO0 + ART0(${Object.keys(artworkImages).length}) + SPR0(${Object.keys(spriteAtlas).length}) + NXVM verified`,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Failed to mount SYSTEM partition';
    pushLog({ stage: 'HOS', level: 'ERR', partition: 'SYSTEM', text: reason });
    throw makeFailure(
      'HOS',
      '2002-4153',
      'Failed to Mount SYSTEM Partition',
      'SYSTEM',
      reason,
      logs
    );
  }
  await pause(stepDelay);

  let settings: ConsoleSettings;
  let profiles: UserProfile[];
  let titles: InstalledTitle[];
  let album: AlbumCapture[];
  let quizPackage: QuizPackage | null = null;

  try {
    const res = await nandStore.readPartitionFiles('USER');
    totalChunksRead += res.chunks.length;
    totalBytesRead += res.meta.usedBytes;

    const setBytes = res.files['/user/save/settings.bin'];
    const prfBytes = res.files['/user/save/profiles.bin'];
    const titBytes = res.files['/user/titles/registry.bin'];
    const albBytes = res.files['/user/album/captures.bin'];

    if (!setBytes || !prfBytes || !titBytes || !albBytes) {
      throw new Error('Missing required binary save tables inside USER partition');
    }

    settings = decodeSet0(setBytes);
    profiles = decodePrf0(prfBytes);
    titles = decodeTit0(titBytes);
    album = decodeAlb0(albBytes);

    if (!profiles.some((p) => p.id === settings.activeUserId)) {
      throw new Error(`Active user "${settings.activeUserId}" in SET0 not found in PRF0 profiles`);
    }

    // Verify 1:1 binary save presence, CRC32 & field synchronization for every installed title
    for (const t of titles) {
      const sBytes = res.files[t.saveFilePath];
      if (!sBytes) {
        throw new Error(`Missing binary save file ${t.saveFilePath} for title ${t.id}`);
      }
      const save = decodeGameSave(sBytes);
      if (!save.valid) {
        throw new Error(`Save file ${t.saveFilePath} marked invalid`);
      }
      if (save.titleId !== t.id) {
        throw new Error(`Save ${t.saveFilePath} titleId (${save.titleId}) != registry (${t.id})`);
      }
      if (save.playMinutes !== t.playMinutes) {
        throw new Error(`Save ${t.saveFilePath} playMinutes (${save.playMinutes}) != registry (${t.playMinutes})`);
      }
      if (t.highScore !== undefined) {
        if (!save.hasHighScore || save.highScore !== t.highScore) {
          throw new Error(`Save ${t.saveFilePath} score (${save.highScore}) != registry (${t.highScore})`);
        }
      } else if (save.hasHighScore || save.highScore !== 0) {
        throw new Error(`Save ${t.saveFilePath} score flag mismatch with non-scored title ${t.id}`);
      }

      if (t.id === 'title-trivia') {
        const installedPkgBytes = res.files['/user/apps/title-trivia.pkg'];
        quizPackage = installedPkgBytes ? decodeQuizPackage(installedPkgBytes) : defaultQuizPackage;
      }
    }

    pushLog({
      stage: 'HOS',
      level: 'OK',
      partition: 'USER',
      chunkInfo: `${res.chunks.length} chunks`,
      text: `Mounted USER tables -> ${profiles.length} profiles, ${titles.length} synced title saves, ${album.length} captures`,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Failed to mount USER partition';
    pushLog({ stage: 'HOS', level: 'ERR', partition: 'USER', text: reason });
    throw makeFailure(
      'HOS',
      '2002-4518',
      'Failed to Mount USER Partition',
      'USER',
      reason,
      logs
    );
  }

  // Execute SYSTEM NXVM bytecode policy (/sys/code/battery_policy.nxb)
  const batteryTelemetry = executeBatteryPolicyVm(batteryPolicyVmBytes, {
    [NXVM_REG.BAT_CAPACITY_MAH]: batteryProfile.capacityMah,
    [NXVM_REG.BAT_CYCLES]: batteryProfile.factoryCycles,
    [NXVM_REG.BAT_RESIST_MOHM]: batteryProfile.internalResistanceMohm,
    [NXVM_REG.SET_BRIGHTNESS]: settings.brightness,
    [NXVM_REG.SET_AIRPLANE]: settings.airplaneMode ? 1 : 0,
    [NXVM_REG.SET_DOCKED]: settings.dockedMode ? 1 : 0,
    [NXVM_REG.PROD_FUSES]: prodInfo.fuseCount,
  });

  callbacks.onStageChange('SPLASH');
  pushLog({
    stage: 'HOS',
    level: 'OK',
    text: `Executed NXVM telemetry (${batteryTelemetry.batteryPercent}% · ${batteryTelemetry.instructionsExecuted} ops) -> launching ${qlaunchNro.name}.nro (${osManifest.homeAppletId})...`,
  });
  await pause(options.fastBoot ? 80 : 220);

  const bootDurationMs = Math.round(performance.now() - startTime);

  return {
    prodInfo,
    osManifest,
    themes: {
      light: lightTheme,
      dark: darkTheme,
    },
    sfxTable,
    localeStrings,
    qlaunchConfig,
    capabilities,
    hardwareCal: {
      touch: touchCal,
      audio: audioCal,
      imu: imuCal,
      railModel,
      battery: batteryProfile,
    },
    artworkImages,
    avatarGlyphs,
    bootSplash,
    spriteAtlas,
    bootChime,
    stellarConfig,
    tetrominoConfig,
    chromaticPads,
    quizPackage,
    qlaunchNro,
    batteryTelemetry,
    settings,
    profiles,
    titles,
    news,
    eshopCatalog,
    album,
    kipsLoaded,
    bootLogs: logs,
    totalChunksRead,
    totalBytesRead,
    bootDurationMs,
  };
}
