import {
  BinaryReader,
  BinaryWriter,
  encodeAlb0,
  encodeCal0,
  encodeEsh0,
  encodeHosm,
  encodeNws0,
  encodePrf0,
  encodeSet0,
  encodeSfx0,
  encodeThm0,
  encodeTit0,
  verifyTrailingCrc32,
} from './binaryStructs';
import { bytesToHex, crc32, sha256Bytes } from './crc32';
import { packNxfs } from './nandFs';
import {
  AlbumCapture,
  ConsoleSettings,
  EshopListing,
  InstalledTitle,
  NewsArticle,
  PartitionId,
  ProdInfoPayload,
  SwitchThemeTokens,
  SystemOsManifest,
  UiSfxTable,
  UserProfile,
} from './nandTypes';
import { buildBatteryPolicyVmBinary } from './nxVm';
import {
  buildArtworkPackBinary,
  buildAvatarGlyphsBinary,
  buildBootChimeBinary,
  buildBootSplashBinary,
  buildChromaticDataBinary,
  buildQlaunchNroBinary,
  buildQuizPackageBinary,
  buildSpriteAtlasBinary,
  buildStellarDataBinary,
  buildTetrominoDataBinary,
} from './systemAssets';

const encoder = new TextEncoder();

/** Fixed deterministic epoch for factory image reproducibility (2026-11-12T12:00:00Z). */
export const FACTORY_EPOCH_MS = Date.UTC(2026, 10, 12, 12, 0, 0);

export interface FactoryPartitionSpec {
  id: PartitionId;
  gptIndex: number;
  label: string;
  description: string;
  requiredBy: 'STAGE1' | 'STAGE2' | 'OS_HOME';
  virtualCapacityBytes: number;
  encrypted: boolean;
  startLba: number;
  endLba: number;
  image: Uint8Array;
}

export function getMasterKeyDigest(revision: number): Uint8Array {
  return sha256Bytes(encoder.encode(`NX-HOS-MASTER-KEY-REV:${revision}`));
}

export function getMasterKeyHashHex(revision: number): string {
  // First 10 bytes (20 uppercase hex characters) of the genuine SHA-256 master key digest
  return bytesToHex(getMasterKeyDigest(revision).subarray(0, 10), true);
}

/**
 * Builds the authentic Tegra X1 Boot Configuration Table (1024 bytes).
 * Zero overlapping fields and zero placeholder digest strings:
 * - [0x00..0x3f] BCT0 header, IRAM entry, exact Stage 1 size, DRAM clock, serial hint
 * - [0x40..0x63] LPDDR4 4GB Samsung/Micron timing table
 * - [0x68..0xaf] PMIC MAX77620 rail sequence (non-overlapping)
 * - [0xb0..0xc7] eMMC 5.1 HS400 controller parameters
 * - [0xe0..0xff] Security Engine Hardware Identity SHA-256
 * - [0x100..0x11f] Real SHA-256 of PRODINFO /cal/cal0_keyblob.bin
 * - [0x120..0x13f] Real SHA-256 of BOOT0 /boot/nx_boot1.bin
 * - [1020..1023] Trailing CRC32 of [0..1020)
 */
function buildBctBinary(
  prodInfo: ProdInfoPayload,
  nxBoot1Bytes: Uint8Array,
  keyblobBytes: Uint8Array
): Uint8Array {
  const bct = new Uint8Array(1024);
  const view = new DataView(bct.buffer);

  // [0x00..0x03] Magic "BCT0"
  bct[0] = 0x42; // B
  bct[1] = 0x43; // C
  bct[2] = 0x54; // T
  bct[3] = 0x30; // 0

  view.setUint32(0x04, 0x00010002, true);        // BCT version 1.2
  view.setUint32(0x08, 0x40010000, true);        // IRAM Stage 1 entry point
  view.setUint32(0x0c, 0x40010000, true);        // Stage 1 load address
  view.setUint32(0x10, nxBoot1Bytes.length, true); // Exact Stage 1 byte size
  view.setUint32(0x14, 1600, true);              // LPDDR4 Clock MHz
  view.setUint32(0x18, 0x00000001, true);        // Boot device type (1 = eMMC)
  view.setUint32(0x1c, 0x00000001, true);        // Hash algorithm (1 = SHA-256)

  // [0x20..0x3f] Console serial hint (linked to PRODINFO CAL0)
  const hintBytes = encoder.encode(prodInfo.serial.slice(0, 31));
  bct.set(hintBytes, 0x20);

  // [0x40..0x63] LPDDR4 SDRAM Controller Configuration (Samsung / Micron 4GB Dual-Channel)
  view.setUint32(0x40, 0x00000004, true); // DRAM Type: LPDDR4
  view.setUint32(0x44, 4096, true);       // Total DRAM Size: 4096 MiB
  view.setUint32(0x48, 64, true);         // Bus Width: 64-bit (2x 32-bit channels)
  view.setUint32(0x4c, 3900, true);       // Refresh Interval tREFI (3.9 us)
  view.setUint16(0x50, 140, true);        // tRFC: 140 ns
  view.setUint16(0x52, 18, true);         // tRP: 18 ns
  view.setUint16(0x54, 18, true);         // tRCD: 18 ns
  view.setUint16(0x56, 42, true);         // tRAS: 42 ns
  view.setUint8(0x58, 14);                // tCL (CAS Latency): 14
  view.setUint8(0x59, 12);                // tCWL: 12
  view.setUint8(0x5a, 30);                // tFAW: 30 ns
  view.setUint8(0x5b, 10);                // tWTR: 10 ns
  view.setUint16(0x5c, 40, true);         // Driver impedance: 40 Ohm
  view.setUint16(0x5e, 60, true);         // ODT: 60 Ohm
  view.setUint16(0x60, 1100, true);       // VDDQ: 1100 mV
  view.setUint16(0x62, 1100, true);       // VDD2: 1100 mV

  // [0x68..0xaf] Power Management IC (MAX77620) Power Rail Sequence (6 x 12 = 72 bytes)
  const pmicRails = [
    { name: 'VDD_CORE', mv: 850, delayUs: 200 },
    { name: 'VDD_CPU',  mv: 950, delayUs: 200 },
    { name: 'VDD_GPU',  mv: 800, delayUs: 200 },
    { name: 'LDO0_LCD', mv: 1200, delayUs: 150 },
    { name: 'LDO1_AUD', mv: 3300, delayUs: 150 },
    { name: 'LDO2_IO',  mv: 1800, delayUs: 150 },
  ];
  let pmicOffset = 0x68;
  for (const rail of pmicRails) {
    bct.set(encoder.encode(rail.name).subarray(0, 8), pmicOffset);
    view.setUint16(pmicOffset + 8, rail.mv, true);
    view.setUint16(pmicOffset + 10, rail.delayUs, true);
    pmicOffset += 12;
  }

  // [0xb0..0xc7] eMMC 5.1 Bus Controller Configuration (24 bytes, non-overlapping)
  view.setUint32(0xb0, 0x00000400, true); // Bus Mode: HS400 DDR
  view.setUint32(0xb4, 8, true);          // Bus Width: 8-bit
  view.setUint32(0xb8, 200, true);        // Clock Frequency: 200 MHz
  view.setUint32(0xbc, 512, true);        // Sector Size: 512 bytes
  view.setUint32(0xc0, 1, true);          // Partition Access: Partition 1 (BOOT0)
  view.setUint32(0xc4, 100, true);        // Read Timeout ms: 100

  // [0xe0..0x13f] Genuine Cryptographic SHA-256 Digests
  const hwIdDigest = sha256Bytes(
    encoder.encode(`NX-SE-ROOT:${prodInfo.serial}:${prodInfo.boardRevision}:${prodInfo.macAddress}`)
  );
  bct.set(hwIdDigest, 0xe0);

  const keyblobDigest = sha256Bytes(keyblobBytes);
  bct.set(keyblobDigest, 0x100);

  const boot1Digest = sha256Bytes(nxBoot1Bytes);
  bct.set(boot1Digest, 0x120);

  // [0x180..0x2ff] Pinmux, Pad Configuration & Hardware Thermal Limits
  view.setUint32(0x180, 85, true);        // Thermal Shutdown Trip Point: 85°C
  view.setUint32(0x184, 200, true);       // LCD Backlight PWM Frequency: 200 Hz
  view.setUint32(0x188, 115200, true);    // Joy-Con UART Rail Baud Rate: 115200 bps
  view.setUint32(0x18c, 16, true);        // Power Button Debounce ms: 16
  view.setUint32(0x190, 0x00000001, true);// USB-C CC Controller: Enabled
  const buildTag = encoder.encode('T210_BCT_NX_18.1.0_LPDDR4_4GB');
  bct.set(buildTag.subarray(0, 32), 0x200);

  // [0x300..0x33f] DRAM Calibration and Channel Routing Matrix
  const dramCal = encoder.encode('SAMSUNG_K4F6E304HB_DUAL_CHANNEL_RANK0_RANK1_CALIBRATED');
  bct.set(dramCal.subarray(0, 64), 0x300);

  // CRC32 of the preceding 1020 bytes placed exactly at offset 1020
  const tableCrc = crc32(bct.subarray(0, 1020));
  view.setUint32(1020, tableCrc, true);
  return bct;
}

/**
 * Builds the Stage 1 Bootloader binary (NX_BOOT1).
 * Embeds the real Stage 2 Package2 byte length and SHA-256 digest at fixed offsets
 * ([0x4c..0x4f] size, [0x50..0x6f] sha256) and uses clean self-contained ARM64 opcodes.
 */
function buildStage1Binary(package2Bytes: Uint8Array): Uint8Array {
  const w = new BinaryWriter(1536);

  // 1. Stage 1 Header (0x00..0x6f = 112 bytes)
  w.writeMagic('NX_BOOT1');                    // [0x00..0x07] Magic: 8 bytes
  w.writeU32(0x40010000);                      // [0x08..0x0b] IRAM Base Entry Point
  w.writeU32((18 << 16) | (1 << 8) | 0);        // [0x0c..0x0f] Stage 1 Build 18.1.0 (0x00120100)
  w.writeU32(4096);                            // [0x10..0x13] DRAM Size (MiB)
  w.writeU32(0x00000001);                      // [0x14..0x17] Security Flags: CAL0 + SHA-256 verified
  w.writeFixedString('BOOT1', 16);             // [0x18..0x27] Target Stage 2 partition
  w.writeFixedString('/pk21/package2.bin', 32);// [0x28..0x47] Target Stage 2 binary path
  w.writeU32(0x80000000);                      // [0x48..0x4b] Stage 2 target load address
  w.writeU32(package2Bytes.length);            // [0x4c..0x4f] Expected Stage 2 exact byte size
  w.writeBytes(sha256Bytes(package2Bytes));    // [0x50..0x6f] Expected Stage 2 real SHA-256 digest (32B)

  // 2. ARM64 Exception Vector Table (VBAR_EL3: 16 branch vectors)
  const vectorBranches = [
    0x14000020, 0x14000024, 0x14000028, 0x1400002c,
    0x14000030, 0x14000034, 0x14000038, 0x1400003c,
    0x14000040, 0x14000044, 0x14000048, 0x1400004c,
    0x14000050, 0x14000054, 0x14000058, 0x1400005c,
  ];
  for (const op of vectorBranches) {
    w.writeU32(op);
  }

  // 3. Self-contained AArch64 initialization sequence (valid ARMv8-A encodings)
  const arm64Instructions = [
    0xd53e1000, // mrs x0, sctlr_el3         (Read System Control Register EL3)
    0x927df800, // and x0, x0, #~0x5         (Clear M and C bits: disable MMU/DCache)
    0xb2740000, // orr x0, x0, #(1 << 12)    (Set I bit: enable Instruction Cache)
    0xd51e1000, // msr sctlr_el3, x0         (Write back SCTLR_EL3)
    0xd5033fdf, // isb                       (Instruction Synchronization Barrier)
    0xd29c0000, // movz x0, #0xe000          (Stack Base low 16 bits)
    0xf2a80060, // movk x0, #0x4003, lsl #16 (x0 = 0x4003E000)
    0x9100001f, // mov sp, x0                (Initialize EL3 SP)
    0xd29f0001, // movz x1, #0xf800          (19.2MHz = 0x0124F800 low 16 bits)
    0xf2a02481, // movk x1, #0x0124, lsl #16 (x1 = 19200000 Hz)
    0xd51be001, // msr cntfrq_el0, x1        (Configure System Counter Frequency)
    0xd53e1140, // mrs x0, cptr_el3          (Read Architectural Feature Trap Register)
    0x9275f800, // bic x0, x0, #(0x3 << 10)  (Enable FP/SIMD)
    0xd51e1140, // msr cptr_el3, x0
    0xd5033fdf, // isb
    0xd2800000, // movz x0, #0               (Build Stage 2 handoff address 0x80000000)
    0xf2b00000, // movk x0, #0x8000, lsl #16 (x0 = 0x80000000)
    0xd61f0000, // br x0                     (Jump to Stage 2 PK21 Entry)
  ];
  for (const op of arm64Instructions) {
    w.writeU32(op);
  }

  // 4. Tegra Security Engine (SE) Key Slot Allocation Table
  const keySlots = [
    { slot: 0, name: 'SE_KEY_SBK',      size: 16, perm: 'READ_PROT' },
    { slot: 1, name: 'SE_KEY_SSK',      size: 16, perm: 'READ_PROT' },
    { slot: 2, name: 'SE_KEY_PACKAGE1', size: 16, perm: 'ENCRYPT_DECRYPT' },
    { slot: 3, name: 'SE_KEY_PACKAGE2', size: 16, perm: 'ENCRYPT_DECRYPT' },
    { slot: 4, name: 'SE_KEY_TITLEKEY', size: 16, perm: 'DECRYPT_ONLY' },
  ];
  w.writeU32(keySlots.length);
  for (const ks of keySlots) {
    w.writeU8(ks.slot);
    w.writeFixedString(ks.name, 16);
    w.writeU8(ks.size);
    w.writeFixedString(ks.perm, 16);
  }

  // 5. Memory Controller Frequency Stepping Table (204MHz, 666MHz, 1600MHz)
  const emcSteps = [
    { freqMhz: 204,  voltageMv: 850,  latency: 10 },
    { freqMhz: 666,  voltageMv: 950,  latency: 12 },
    { freqMhz: 1600, voltageMv: 1100, latency: 14 },
  ];
  w.writeU32(emcSteps.length);
  for (const step of emcSteps) {
    w.writeU32(step.freqMhz);
    w.writeU32(step.voltageMv);
    w.writeU32(step.latency);
  }

  // 6. eMMC Controller Initialization Command Table
  const emmcCommands = [
    { cmd: 0,  arg: 0x00000000, resp: 'NONE', desc: 'CMD0_GO_IDLE_STATE' },
    { cmd: 1,  arg: 0x40ff8000, resp: 'R3',   desc: 'CMD1_SEND_OP_COND' },
    { cmd: 2,  arg: 0x00000000, resp: 'R2',   desc: 'CMD2_ALL_SEND_CID' },
    { cmd: 3,  arg: 0x00010000, resp: 'R6',   desc: 'CMD3_SET_RELATIVE_ADDR' },
    { cmd: 6,  arg: 0x03b30101, resp: 'R1B',  desc: 'CMD6_SWITCH_PARTITION_BOOT1' },
    { cmd: 17, arg: 0x00002000, resp: 'R1',   desc: 'CMD17_READ_STAGE2_BLOCK' },
  ];
  w.writeU32(emmcCommands.length);
  for (const c of emmcCommands) {
    w.writeU8(c.cmd);
    w.writeU32(c.arg);
    w.writeFixedString(c.resp, 8);
    w.writeFixedString(c.desc, 32);
  }

  return w.finishWithCrc32();
}

function buildStage1Header(nxBoot1Bytes: Uint8Array): Uint8Array {
  const w = new BinaryWriter(96);
  w.writeMagic('STG1');
  w.writeU8(1); // stage 1
  w.writeU8(1); // dram initialized
  w.writeU16(2); // bct version
  w.writeU32(0x40010000);
  w.writeFixedString('BOOT1', 16);
  w.writeU32(nxBoot1Bytes.length);
  w.writeBytes(sha256Bytes(nxBoot1Bytes));
  return w.finishWithCrc32();
}

/**
 * Builds the Stage 2 Package2 binary (PK21).
 * Embeds the genuine SHA-256 digest and byte size of every required KIP1 module
 * in BCPKG2 starting at offset 0x30.
 */
function buildStage2Package2Binary(
  kipEntries: Array<{ name: string; bytes: Uint8Array }>
): Uint8Array {
  const w = new BinaryWriter(2048);

  // 1. Package2 Header [0x00..0x2f = 48 bytes]
  w.writeMagic('PK21');                   // [0x00..0x03] Magic: 4 bytes
  w.writeU32(0x80000000);                 // [0x04..0x07] Horizon Kernel Load Address
  w.writeU32((18 << 16) | (1 << 8) | 0);   // [0x08..0x0b] PK21 Version 18.1.0 (0x00120100)
  w.writeU32(kipEntries.length);          // [0x0c..0x0f] Required KIP1 Module Count
  w.writeFixedString('BCPKG2', 8);        // [0x10..0x17] KIP1 Partition Source
  w.writeFixedString('SYSTEM', 8);        // [0x18..0x1f] System OS Partition Mount
  w.writeFixedString('USER', 8);          // [0x20..0x27] User Data Partition Mount
  w.writeFixedString('SAFE', 8);          // [0x28..0x2f] Maintenance Partition Mount

  // 2. Cryptographic KIP1 Manifest Table [starts at 0x30]
  // Each entry: name(16B) + size(U32) + sha256(32B) = 52 bytes
  for (const kip of kipEntries) {
    w.writeFixedString(kip.name, 16);
    w.writeU32(kip.bytes.length);
    w.writeBytes(sha256Bytes(kip.bytes));
  }

  // 3. Horizon Microkernel System Call (SVC) Registry Table
  const syscalls = [
    { id: 0x01, name: 'svcSetHeapSize' },
    { id: 0x03, name: 'svcControlCodeMemory' },
    { id: 0x06, name: 'svcQueryMemory' },
    { id: 0x08, name: 'svcCreateThread' },
    { id: 0x09, name: 'svcStartThread' },
    { id: 0x0b, name: 'svcSleepThread' },
    { id: 0x18, name: 'svcWaitSynchronization' },
    { id: 0x1f, name: 'svcConnectToNamedPort' },
    { id: 0x21, name: 'svcSendSyncRequest' },
    { id: 0x22, name: 'svcSendSyncRequestWithUserBuffer' },
    { id: 0x26, name: 'svcBreak' },
    { id: 0x27, name: 'svcOutputDebugString' },
  ];
  w.writeU32(syscalls.length);
  for (const s of syscalls) {
    w.writeU16(s.id);
    w.writeFixedString(s.name, 32);
  }

  // 4. Kernel Memory Layout Pools
  const memPools = [
    { pool: 'APPLICATION', sizeMb: 3285, baseAddr: '0x0000008000000000' },
    { pool: 'APPLET',      sizeMb: 520,  baseAddr: '0x0000007800000000' },
    { pool: 'SYSTEM',      sizeMb: 280,  baseAddr: '0x0000007000000000' },
    { pool: 'KERNEL_SLAB', sizeMb: 64,   baseAddr: '0x0000000080000000' },
  ];
  w.writeU32(memPools.length);
  for (const mp of memPools) {
    w.writeFixedString(mp.pool, 16);
    w.writeU32(mp.sizeMb);
    w.writeFixedString(mp.baseAddr, 20);
  }

  // 5. Kernel Boot Arguments String
  const bootArgs =
    'hos_version=18.1.0 build=HOS-18.1.0-R4921 splash_color=#E60012 splash_text=crimson_nx ' +
    'mem_budget=4096M kips=fs,loader,sm,pm,hid,am,nvdrv mounts=SYSTEM,USER,SAFE debug=0';
  w.writeVarString(bootArgs);

  // 6. Kernel ARM64 Early Bootstrap Instructions
  const kernelJumpStub = [
    0xd2800000, // movz x0, #0
    0xd5184000, // msr spsr_el1, x0 (Clear SPSR_EL1)
    0xd2800001, // movz x1, #0
    0xf2b00001, // movk x1, #0x8000, lsl #16 (x1 = 0x80000000)
    0xd51e4021, // msr elr_el3, x1  (Set ELR_EL3 to Kernel Entry)
    0xd69f03e0, // eret             (Exception return to EL1 Horizon Kernel)
  ];
  for (const op of kernelJumpStub) {
    w.writeU32(op);
  }

  return w.finishWithCrc32();
}

function buildStage2Header(package2Bytes: Uint8Array, kipCount: number): Uint8Array {
  const w = new BinaryWriter(96);
  w.writeMagic('STG2');
  w.writeU8(2);
  w.writeU8(kipCount);
  w.writeU16(0);
  w.writeU32(0x80000000);
  w.writeFixedString('PK21', 8);
  w.writeU32(package2Bytes.length);
  w.writeBytes(sha256Bytes(package2Bytes));
  return w.finishWithCrc32();
}

/**
 * Builds an authentic KIP1 binary for a Horizon kernel initial process.
 */
function buildKip1Binary(
  name: string,
  titleId: string,
  ports: string[],
  commands: { id: number; name: string }[],
  priority: number,
  affinity: number
): Uint8Array {
  const w = new BinaryWriter(1024);

  w.writeMagic('KIP1');                   // Magic: 4 bytes
  w.writeFixedString(name, 12);           // Service name
  w.writeFixedString(titleId, 16);        // Title ID
  w.writeU32(0x0000003f);                 // KIP flags (64-bit address space, etc.)
  w.writeU8(priority);                    // Main thread priority (16-24)
  w.writeU8(affinity);                    // Core affinity (0-3)
  w.writeU16(0x0100);                     // KIP format version 1.0

  // 1. Horizon Section Descriptors (.text, .rodata, .data, .bss)
  const sections = [
    { name: '.text',   offset: 0x00000100, size: 0x00018000, compSize: 0x00018000, attr: 0x05 },
    { name: '.rodata', offset: 0x00018100, size: 0x00008000, compSize: 0x00008000, attr: 0x04 },
    { name: '.data',   offset: 0x00020100, size: 0x00004000, compSize: 0x00004000, attr: 0x06 },
    { name: '.bss',    offset: 0x00024100, size: 0x0000c000, compSize: 0x0000c000, attr: 0x06 },
  ];
  w.writeU16(sections.length);
  for (const sec of sections) {
    w.writeFixedString(sec.name, 8);
    w.writeU32(sec.offset);
    w.writeU32(sec.size);
    w.writeU32(sec.compSize);
    w.writeU32(sec.attr);
  }

  // 2. Kernel Capability Descriptors
  const kernelCaps = [
    0x0000001f, // Kernel SVC 0x00-0x1F permission mask
    0x0000000f, // Kernel SVC 0x20-0x3F permission mask
    0x0000ffff, // Inter-Process Thread Stack 64KB
    0x00000080, // Memory Map Access flags
    0x00000003, // Allowed Core Mask (Cores 0-3)
    0x00000100, // Handle Table Size: 256 handles
  ];
  w.writeU16(kernelCaps.length);
  for (const cap of kernelCaps) {
    w.writeU32(cap);
  }

  // 3. IPC Ports exposed by this service
  w.writeU16(ports.length);
  for (const port of ports) {
    w.writeFixedString(port, 12);
  }

  // 4. IPC Command ID definitions
  w.writeU16(commands.length);
  for (const cmd of commands) {
    w.writeU16(cmd.id);
    w.writeFixedString(cmd.name, 32);
  }

  // 5. AArch64 Executable Service Handler Stub (.text machine code)
  const svcCode = [
    0xa9bf7bfd, // stp x29, x30, [sp, #-16]!
    0x910003fd, // mov x29, sp
    0xd2800000 | ((priority & 0xfff) << 5), // movz x0, #priority
    0xd40003e1, // svc #0x1f (svcConnectToNamedPort)
    0xd4000421, // svc #0x21 (svcSendSyncRequest)
    0xd2800000, // mov x0, #0
    0xa8c17bfd, // ldp x29, x30, [sp], #16
    0xd65f03c0, // ret
  ];
  w.writeU16(svcCode.length);
  for (const op of svcCode) {
    w.writeU32(op >>> 0);
  }

  return w.finishWithCrc32();
}

/**
 * Builds factory cryptographic key store (KB00 v2).
 * Every key slot, Package1 hash, Package2 hash, RSA/ECC fingerprint, and SSL cert hash
 * is a genuine 32-byte SHA-256 digest derived deterministically from real inputs.
 */
function buildKeyblobBinary(
  prodInfo: ProdInfoPayload,
  nxBoot1Bytes: Uint8Array,
  package2Bytes: Uint8Array
): Uint8Array {
  const w = new BinaryWriter(1024);

  w.writeMagic('KB00');
  w.writeU16(2);  // Keyblob format v2 (pure 32-byte SHA-256 digests)
  w.writeU16(19); // 19 master key revisions (0x00 through 0x12)

  // Master Key Revisions 00..18: rev(U8) + sha256(32B) = 33 bytes each
  for (let rev = 0; rev < 19; rev++) {
    w.writeU8(rev);
    w.writeBytes(getMasterKeyDigest(rev));
  }

  // Package1 (NX_BOOT1) & Package2 (PK21) exact SHA-256 digests (32B each)
  w.writeBytes(sha256Bytes(nxBoot1Bytes));
  w.writeBytes(sha256Bytes(package2Bytes));

  // Device Unique Public Key Parameters & SHA-256 Fingerprints
  const deviceSeed = `${prodInfo.serial}|${prodInfo.macAddress}|${prodInfo.boardRevision}`;
  w.writeU32(2048);  // RSA Key Size
  w.writeU32(65537); // RSA Public Exponent
  w.writeBytes(sha256Bytes(encoder.encode(`${deviceSeed}|RSA2048_MODULUS`)));
  w.writeBytes(sha256Bytes(encoder.encode(`${deviceSeed}|ECC_P256_QX`)));
  w.writeBytes(sha256Bytes(encoder.encode(`${deviceSeed}|ECC_P256_QY`)));
  w.writeBytes(sha256Bytes(encoder.encode(`${deviceSeed}|${prodInfo.region}|${prodInfo.sku}|SSL_CLIENT_V18`)));

  return w.finishWithCrc32();
}

export interface DecodedKeyblob {
  version: number;
  revisionCount: number;
  masterKeyDigests: Uint8Array[];
  pkg1Sha256: Uint8Array;
  pkg2Sha256: Uint8Array;
}

export function decodeKeyblobBinary(bytes: Uint8Array): DecodedKeyblob {
  verifyTrailingCrc32(bytes, 'PRODINFO KB00');
  const r = new BinaryReader(bytes);
  const magic = r.readMagic(4);
  if (magic !== 'KB00') throw new Error(`Invalid KB00 magic "${magic}"`);
  const version = r.readU16();
  const revisionCount = r.readU16();
  const masterKeyDigests: Uint8Array[] = [];
  for (let i = 0; i < revisionCount; i++) {
    r.readU8(); // rev index
    masterKeyDigests.push(r.readBytes(32));
  }
  const pkg1Sha256 = r.readBytes(32);
  const pkg2Sha256 = r.readBytes(32);
  return {
    version,
    revisionCount,
    masterKeyDigests,
    pkg1Sha256,
    pkg2Sha256,
  };
}

/**
 * Builds factory touch screen digitizer calibration matrix.
 */
function buildTouchCalBinary(): Uint8Array {
  const w = new BinaryWriter(128);
  w.writeMagic('TCAL');
  w.writeU16(1280); // Width px
  w.writeU16(720);  // Height px
  w.writeU8(10);    // Max touch points
  w.writeU8(1);     // Jitter filter enabled
  const points = [
    { sx: 128, sy: 72,   adcX: 204,  adcY: 102 },
    { sx: 1152, sy: 72,  adcX: 1840, adcY: 104 },
    { sx: 640, sy: 648,  adcX: 1024, adcY: 920 },
  ];
  for (const pt of points) {
    w.writeU16(pt.sx);
    w.writeU16(pt.sy);
    w.writeU16(pt.adcX);
    w.writeU16(pt.adcY);
  }
  return w.finishWithCrc32();
}

/**
 * Builds factory audio codec calibration profile.
 */
function buildAudioCalBinary(): Uint8Array {
  const w = new BinaryWriter(128);
  w.writeMagic('ACAL');
  w.writeFixedString('ALC5639', 8);
  w.writeU8(85);  // Max headphone dB limit
  w.writeU8(92);  // Speaker boost gain dB
  w.writeU8(1);   // Noise cancellation active
  const eqBands = [
    { freqHz: 100,   gainDb: 2 },
    { freqHz: 500,   gainDb: 0 },
    { freqHz: 1500,  gainDb: -1 },
    { freqHz: 4000,  gainDb: 1 },
    { freqHz: 10000, gainDb: 3 },
  ];
  for (const b of eqBands) {
    w.writeU16(b.freqHz);
    w.writeU8(b.gainDb + 128);
  }
  return w.finishWithCrc32();
}

/**
 * Builds factory 6-axis IMU calibration.
 */
function buildImuCalBinary(): Uint8Array {
  const w = new BinaryWriter(128);
  w.writeMagic('ICAL');
  w.writeFixedString('ICM20600', 8);
  w.writeF32(0.0012);
  w.writeF32(-0.0008);
  w.writeF32(0.9994);
  w.writeF32(0.0002);
  w.writeF32(-0.0001);
  w.writeF32(0.00005);
  return w.finishWithCrc32();
}

/**
 * Builds factory Joy-Con rail calibration (FCA0).
 */
function buildFactoryRailCal(): Uint8Array {
  const w = new BinaryWriter(64);
  w.writeMagic('FCA0');
  w.writeF32(1.0);
  w.writeF32(1.0);
  w.writeU16(4310);
  w.writeU8(1);
  w.writeFixedString('HAC-003', 16);
  return w.finishWithCrc32();
}

/**
 * Builds battery charging profile & fuel-gauge curves.
 */
function buildBatteryProfileBinary(): Uint8Array {
  const w = new BinaryWriter(128);
  w.writeMagic('BAT0');
  w.writeFixedString('HAC-003', 12);
  w.writeU16(4310); // Capacity mAh
  w.writeU16(160);  // 16.0 Wh (scaled x10)
  w.writeU16(3700); // Nominal mV
  w.writeU16(4200); // Max Charge mV
  w.writeU16(3300); // Cutoff mV
  w.writeU16(184);  // Factory cycle count
  w.writeU16(42);   // Internal resistance mOhm
  return w.finishWithCrc32();
}

function buildSafeRecoveryBinary(): Uint8Array {
  const w = new BinaryWriter(64);
  w.writeMagic('SAFE');
  w.writeU8(18);
  w.writeU8(1);
  w.writeU8(0);
  w.writeU8(0x03); // allowInitialize | allowNandRepair
  w.writeFixedString('MAINTENANCE_MODE', 24);
  return w.finishWithCrc32();
}

function buildRecoveryUiBinary(): Uint8Array {
  const w = new BinaryWriter(128);
  w.writeMagic('RFUI');
  w.writeFixedString('RECOVERY_MENU_18.1.0', 24);
  w.writeU8(3);
  w.writeFixedString('INITIALIZE_PRESERVE_SAVES', 32);
  w.writeFixedString('RESTORE_FACTORY_SETTINGS', 32);
  w.writeFixedString('UPDATE_FROM_NAND_CACHE', 32);
  return w.finishWithCrc32();
}

function buildQlaunchHeader(): Uint8Array {
  const w = new BinaryWriter(64);
  w.writeMagic('QAPP');
  w.writeU16(12); // grid slots
  w.writeU16(6);  // system applets
  w.writeFixedString('0100000000001000', 20);
  w.writeFixedString('qlaunch', 16);
  return w.finishWithCrc32();
}

function buildSystemStringsBinary(): Uint8Array {
  const w = new BinaryWriter(1024);
  w.writeMagic('STR0');
  const strings = [
    { key: 'OK', text: 'OK' },
    { key: 'CANCEL', text: 'Cancel' },
    { key: 'BACK', text: 'Back' },
    { key: 'CLOSE', text: 'Close' },
    { key: 'START', text: 'Start' },
    { key: 'OPTIONS', text: 'Options' },
    { key: 'SLEEP', text: 'Sleep Mode' },
    { key: 'SLEEP_HINT', text: 'Click screen or press A / HOME to wake Horizon-NX' },
    { key: 'RESTART', text: 'Restart (Execute Stage 1 -> Stage 2)' },
    { key: 'POWER_OFF', text: 'Power Off' },
    { key: 'SYSTEM_SETTINGS', text: 'System Settings' },
    { key: 'NEWS_APP', text: 'News' },
    { key: 'ESHOP_APP', text: 'Nintendo eShop' },
    { key: 'ALBUM_APP', text: 'Album' },
    { key: 'CONTROLLERS_APP', text: 'Controllers' },
    { key: 'POWER_APP', text: 'Sleep / Power' },
    { key: 'BACK_HOME', text: 'B · Back to HOME' },
    { key: 'QUICK_SETTINGS', text: 'Quick Settings' },
  ];
  w.writeU16(strings.length);
  for (const s of strings) {
    w.writeFixedString(s.key, 16);
    w.writeVarString(s.text);
  }
  return w.finishWithCrc32();
}

function buildCapabilitiesBinary(): Uint8Array {
  const w = new BinaryWriter(256);
  w.writeMagic('CAP0');
  const caps = [
    { titleId: '0100000000001000', flags: 0x0000007f, name: 'qlaunch_home_menu' },
    { titleId: '010000000000100B', flags: 0x0000001f, name: 'settings_applet' },
    { titleId: '0100000000001007', flags: 0x00000007, name: 'album_applet' },
    { titleId: '010000000000100F', flags: 0x0000000f, name: 'eshop_applet' },
  ];
  w.writeU16(caps.length);
  for (const c of caps) {
    w.writeFixedString(c.titleId, 20);
    w.writeU32(c.flags);
    w.writeFixedString(c.name, 24);
  }
  return w.finishWithCrc32();
}

/**
 * Builds binary save state data for titles installed on USER NAND.
 * flags: bit 0 (0x01) = saveValid, bit 1 (0x02) = hasHighScore.
 */
export function buildGameSaveBinary(
  titleId: string,
  highScore: number,
  playMinutes: number,
  lastSavedAt?: number,
  hasHighScore = true,
  profileId = 'usr-1'
): Uint8Array {
  const w = new BinaryWriter(128);
  w.writeMagic('SAVE');
  w.writeFixedString(titleId, 16);
  w.writeU32(hasHighScore ? highScore : 0);
  w.writeU32(playMinutes);
  w.writeF64(lastSavedAt ?? FACTORY_EPOCH_MS);
  w.writeU8(hasHighScore ? 0x03 : 0x01); // valid (+ hasHighScore bit)
  w.writeFixedString(profileId, 16);
  return w.finishWithCrc32();
}

/**
 * Decodes a binary SAVE structure.
 */
export function decodeGameSave(bytes: Uint8Array): {
  titleId: string;
  highScore: number;
  hasHighScore: boolean;
  playMinutes: number;
  lastSavedAt: number;
  valid: boolean;
  profileId: string;
} {
  verifyTrailingCrc32(bytes, 'USER SAVE');
  const r = new BinaryReader(bytes);
  const magic = r.readMagic(4);
  if (magic !== 'SAVE') throw new Error(`Invalid SAVE magic: "${magic}"`);
  const titleId = r.readFixedString(16);
  const highScore = r.readU32();
  const playMinutes = r.readU32();
  const lastSavedAt = r.readF64();
  const flags = r.readU8();
  const valid = (flags & 0x01) === 0x01;
  const hasHighScore = (flags & 0x02) === 0x02;
  const profileId = r.readFixedString(16);
  return { titleId, highScore, hasHighScore, playMinutes, lastSavedAt, valid, profileId };
}

export const DEFAULT_PRODINFO: ProdInfoPayload = {
  magic: 'CAL0',
  serial: 'XAW10074829104',
  sku: 'HAC-001(-01)',
  region: 'USA',
  macAddress: '98:B6:E9:4A:7C:12',
  fuseCount: 19,
  boardRevision: 'HAD-CPU-01',
  masterKeyHash: getMasterKeyHashHex(18),
  lcdProfile: 'JDI-LPM062M326A-60Hz',
};

export const DEFAULT_OS_MANIFEST: SystemOsManifest = {
  osVersion: '18.1.0',
  codename: 'Horizon-NX',
  buildHash: 'HOS-18.1.0-R4921',
  kernelEntry: '0x80000000',
  requiredKips: [
    'fs.kip1',
    'loader.kip1',
    'sm.kip1',
    'pm.kip1',
    'hid.kip1',
    'am.kip1',
    'nvdrv.kip1',
  ],
  homeAppletId: '0100000000001000',
  splashColor: '#E60012',
  splashAccent: '#FFFFFF',
};

export const DEFAULT_LIGHT_THEME: SwitchThemeTokens = {
  id: 'light',
  name: 'Basic White',
  bgCanvas: '#EBEBEB',
  bgHeader: '#EBEBEB',
  bgTile: '#FFFFFF',
  bgTileEmpty: '#DFDFDF',
  bgAppletBtn: '#FFFFFF',
  bgModal: '#F5F5F5',
  textPrimary: '#2D2D2D',
  textSecondary: '#6F6F6F',
  borderHairline: '#D4D4D4',
  focusCyan: '#0AB9E6',
};

export const DEFAULT_DARK_THEME: SwitchThemeTokens = {
  id: 'dark',
  name: 'Basic Black',
  bgCanvas: '#2D2D2D',
  bgHeader: '#2D2D2D',
  bgTile: '#3B3B3B',
  bgTileEmpty: '#343434',
  bgAppletBtn: '#3E3E3E',
  bgModal: '#242424',
  textPrimary: '#F7F7F7',
  textSecondary: '#A8A8A8',
  borderHairline: '#454545',
  focusCyan: '#0AB9E6',
};

export const DEFAULT_SFX_TABLE: UiSfxTable = {
  tick: { freq: 880, freqEnd: 1040, durationMs: 32, type: 'sine', gain: 0.05 },
  select: { freq: 660, freqEnd: 990, durationMs: 68, type: 'triangle', gain: 0.08 },
  back: { freq: 520, freqEnd: 340, durationMs: 55, type: 'sine', gain: 0.06 },
  launch: { freq: 440, freqEnd: 1320, durationMs: 160, type: 'triangle', gain: 0.1 },
  click: { freq: 1400, freqEnd: 780, durationMs: 42, type: 'square', gain: 0.05 },
  modal: { freq: 620, freqEnd: 740, durationMs: 60, type: 'sine', gain: 0.06 },
  error: { freq: 210, freqEnd: 150, durationMs: 180, type: 'square', gain: 0.07 },
  sleep: { freq: 480, freqEnd: 180, durationMs: 190, type: 'sine', gain: 0.07 },
};

export const DEFAULT_SETTINGS: ConsoleSettings = {
  nickname: 'Horizon-NX',
  theme: 'light',
  clock24h: false,
  airplaneMode: false,
  wifiSsid: 'NX-Lab-5GHz',
  brightness: 100,
  volume: 75,
  muted: false,
  autoSleepMinutes: 10,
  activeUserId: 'usr-1',
  dockedMode: false,
};

export const DEFAULT_PROFILES: UserProfile[] = [
  {
    id: 'usr-1',
    name: 'Alex',
    avatarBg: '#E60012',
    avatarGlyph: 'gamepad',
    playHoursTotal: 142,
    friendCode: 'SW-4821-9034-1172',
  },
  {
    id: 'usr-2',
    name: 'DevKit',
    avatarBg: '#0AB9E6',
    avatarGlyph: 'star',
    playHoursTotal: 38,
    friendCode: 'SW-8802-1194-5503',
  },
];

export const DEFAULT_TITLES: InstalledTitle[] = [
  {
    id: 'title-stellar',
    title: 'Stellar Odyssey',
    publisher: 'Astra Labs',
    version: '1.4.2',
    category: 'game',
    artworkId: 'stellar',
    runnerType: 'stellar',
    sizeMb: 4280,
    playMinutes: 1840,
    lastPlayed: FACTORY_EPOCH_MS - 3600_000 * 3,
    highScore: 2400,
    saveFilePath: '/user/save/stellar.dat',
    pinnedOrder: 0,
    isGameCard: true,
  },
  {
    id: 'title-blocks',
    title: 'Block Stack DX',
    publisher: 'Kyoto Pixel Works',
    version: '2.0.1',
    category: 'game',
    artworkId: 'blocks',
    runnerType: 'blocks',
    sizeMb: 840,
    playMinutes: 920,
    lastPlayed: FACTORY_EPOCH_MS - 3600_000 * 14,
    highScore: 1850,
    saveFilePath: '/user/save/blocks.dat',
    pinnedOrder: 1,
  },
  {
    id: 'title-chromatic',
    title: 'Chromatic Drift',
    publisher: 'Pulse Synth Studio',
    version: '1.1.0',
    category: 'game',
    artworkId: 'chromatic',
    runnerType: 'chromatic',
    sizeMb: 1210,
    playMinutes: 465,
    lastPlayed: FACTORY_EPOCH_MS - 3600_000 * 28,
    highScore: 14,
    saveFilePath: '/user/save/chromatic.dat',
    pinnedOrder: 2,
  },
  {
    id: 'title-hex',
    title: 'NAND Hex & Partition Inspector',
    publisher: 'NX Hardware Tools',
    version: '3.2.0',
    category: 'tool',
    artworkId: 'hex',
    runnerType: 'hex',
    sizeMb: 42,
    playMinutes: 310,
    lastPlayed: FACTORY_EPOCH_MS - 3600_000 * 40,
    saveFilePath: '/user/save/inspector.dat',
    pinnedOrder: 3,
  },
  {
    id: 'title-sketch',
    title: 'Tactile Sketchpad',
    publisher: 'Studio Canvas',
    version: '1.0.5',
    category: 'homebrew',
    artworkId: 'sketch',
    runnerType: 'sketch',
    sizeMb: 118,
    playMinutes: 195,
    lastPlayed: FACTORY_EPOCH_MS - 3600_000 * 72,
    saveFilePath: '/user/save/sketch.dat',
    pinnedOrder: 4,
  },
  {
    id: 'title-cart',
    title: 'Virtual Game Card Slot',
    publisher: 'System Cartridge Bridge',
    version: '1.0.0',
    category: 'cartridge',
    artworkId: 'cartridge',
    runnerType: 'cartridge',
    sizeMb: 16,
    playMinutes: 45,
    lastPlayed: FACTORY_EPOCH_MS - 3600_000 * 96,
    saveFilePath: '/user/save/cartridge.dat',
    pinnedOrder: 5,
  },
];

export const DEFAULT_NEWS: NewsArticle[] = [
  {
    id: 'news-1',
    channel: 'System Firmware Dispatch',
    title: 'Horizon-NX 18.1.0 Binary NXFS & Chunked eMMC Architecture',
    date: '2026-11-12',
    summary:
      'Learn how Stage 1 (NX_BOOT1) and Stage 2 (PK21) verify SHA-256 chains across binary GPT partitions stored in IndexedDB.',
    body: 'Every time this console powers on, Stage 1 reads BOOT0 binary chunks from IndexedDB, checks the BCT0 CRC32 and SHA-256 of NX_BOOT1, validates PRODINFO CAL0 and KB00 keyblobs, then verifies Stage 2 PK21 in BOOT1 and all 7 KIP1 kernel modules in BCPKG2 before mounting SYSTEM and USER.',
    accentColor: '#E60012',
  },
  {
    id: 'news-2',
    channel: 'Astra Labs Bulletin',
    title: 'Stellar Odyssey Update 1.4.2 Now Available',
    date: '2026-11-08',
    summary:
      'Improved starfield particle physics and synchronized binary save-state persistence into the USER NAND partition.',
    body: 'High scores achieved in Stellar Odyssey are written simultaneously to /user/titles/registry.bin (TIT0) and /user/save/stellar.dat (SAVE) inside 16 KiB Uint8Array chunks in IndexedDB.',
    accentColor: '#0AB9E6',
  },
  {
    id: 'news-3',
    channel: 'NX Hardware Tools',
    title: 'Try Fault Injection & Full Dump Verification',
    date: '2026-11-01',
    summary:
      'Test real bootloader SHA-256 and CRC32 verification by inspecting or injecting faults into any partition.',
    body: 'Launch NAND Hex & Partition Inspector or open Bootloader Maintenance to inspect live hex dumps, run the full cross-partition cryptographic audit, or export rawnand.bin and verify it offline with scripts/nx_nand_tool.py.',
    accentColor: '#F59E0B',
  },
];

export const DEFAULT_ESHOP_CATALOG: EshopListing[] = [
  {
    id: 'title-trivia',
    title: 'Console Architecture Quiz',
    publisher: 'NX Academy',
    version: '1.2.0',
    category: 'game',
    artworkId: 'trivia',
    runnerType: 'trivia',
    sizeMb: 290,
    priceLabel: 'Free Download',
    description:
      'Test your knowledge of ARM bootloaders, eMMC partitions, and console hardware design. Downloads directly into USER NAND chunks.',
  },
  {
    id: 'title-sketch',
    title: 'Tactile Sketchpad',
    publisher: 'Studio Canvas',
    version: '1.0.5',
    category: 'homebrew',
    artworkId: 'sketch',
    runnerType: 'sketch',
    sizeMb: 118,
    priceLabel: 'Installed',
    description:
      'Draw pixel-crisp sketches and export screenshots straight into your USER partition Album.',
  },
  {
    id: 'title-stellar',
    title: 'Stellar Odyssey',
    publisher: 'Astra Labs',
    version: '1.4.2',
    category: 'game',
    artworkId: 'stellar',
    runnerType: 'stellar',
    sizeMb: 4280,
    priceLabel: 'Installed',
    description:
      'Fast-paced arcade space interceptor. Dodge asteroid waves and set persistent high scores on NAND.',
  },
];

export const DEFAULT_ALBUM: AlbumCapture[] = [
  {
    id: 'cap-boot-welcome',
    title: 'Horizon-NX Factory Calibration Capture',
    gameTitle: 'System Initial Setup',
    capturedAt: FACTORY_EPOCH_MS - 86400_000 * 2,
    dataUrl:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#E60012"/><stop offset="100%" stop-color="#99000C"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><rect x="260" y="95" width="54" height="170" rx="22" fill="none" stroke="#fff" stroke-width="14"/><circle cx="287" cy="145" r="12" fill="#fff"/><path d="M332 95h28a26 26 0 0 1 26 26v118a26 26 0 0 1-26 26h-28V95z" fill="#fff"/><circle cx="359" cy="196" r="12" fill="#E60012"/><text x="320" y="315" fill="#fff" font-family="sans-serif" font-size="18" font-weight="700" text-anchor="middle">NX-OS 18.1.0 FACTORY CALIBRATION</text></svg>`
      ),
  },
];

export function buildFactoryPartitionSpecs(): FactoryPartitionSpec[] {
  // 1. Build BCPKG2 KIP1 modules first so PK21 can pin their real SHA-256 digests
  const kipFiles: Array<{ name: string; bytes: Uint8Array }> = [
    {
      name: 'fs.kip1',
      bytes: buildKip1Binary(
        'FS',
        '0100000000000000',
        ['fsp-srv', 'fsp-pr', 'fsp-ldr'],
        [
          { id: 0, name: 'OpenFileSystem' },
          { id: 1, name: 'OpenFile' },
          { id: 2, name: 'CreateFile' },
          { id: 3, name: 'OpenSaveDataFileSystem' },
          { id: 4, name: 'GetFreeSpaceSize' },
        ],
        16,
        3
      ),
    },
    {
      name: 'loader.kip1',
      bytes: buildKip1Binary(
        'Loader',
        '0100000000000001',
        ['ldr:pm', 'ldr:ro', 'ldr:dmnt'],
        [
          { id: 0, name: 'CreateProcess' },
          { id: 1, name: 'GetProgramInfo' },
          { id: 2, name: 'PinProgram' },
          { id: 3, name: 'LoadProgram' },
        ],
        18,
        3
      ),
    },
    {
      name: 'sm.kip1',
      bytes: buildKip1Binary(
        'SM',
        '0100000000000002',
        ['sm:'],
        [
          { id: 0, name: 'Initialize' },
          { id: 1, name: 'GetService' },
          { id: 2, name: 'RegisterService' },
          { id: 3, name: 'UnregisterService' },
        ],
        16,
        3
      ),
    },
    {
      name: 'pm.kip1',
      bytes: buildKip1Binary(
        'PM',
        '0100000000000003',
        ['pm:shell', 'pm:info', 'pm:bm'],
        [
          { id: 0, name: 'LaunchProgram' },
          { id: 1, name: 'TerminateProcess' },
          { id: 2, name: 'GetProcessInfo' },
          { id: 3, name: 'BoostMemoryBudget' },
        ],
        18,
        3
      ),
    },
    {
      name: 'hid.kip1',
      bytes: buildKip1Binary(
        'HID',
        '0100000000000008',
        ['hid', 'hid:dbg', 'hid:sys'],
        [
          { id: 0, name: 'CreateAppletResource' },
          { id: 1, name: 'GetSharedMemoryHandle' },
          { id: 2, name: 'SendVibrationValue' },
          { id: 3, name: 'SetSupportedNpadStyleSet' },
        ],
        20,
        3
      ),
    },
    {
      name: 'am.kip1',
      bytes: buildKip1Binary(
        'AM',
        '0100000000000017',
        ['am:applet', 'am:sys', 'am:gpu'],
        [
          { id: 0, name: 'OpenLibraryAppletProxy' },
          { id: 1, name: 'OpenApplicationProxy' },
          { id: 2, name: 'CreateManagedDisplayLayer' },
          { id: 3, name: 'GetDesiredLanguage' },
        ],
        20,
        3
      ),
    },
    {
      name: 'nvdrv.kip1',
      bytes: buildKip1Binary(
        'NVDRV',
        '0100000000000012',
        ['nvdrv', 'nvdrv:a'],
        [
          { id: 0, name: 'OpenDevice' },
          { id: 1, name: 'Ioctl' },
          { id: 2, name: 'CloseDevice' },
          { id: 3, name: 'InitializeDriver' },
        ],
        22,
        3
      ),
    },
  ];

  const bcpkg2FileMap: Record<string, Uint8Array> = {};
  for (const k of kipFiles) {
    bcpkg2FileMap[`/kip1/${k.name}`] = k.bytes;
  }
  const bcpkg2Image = packNxfs(bcpkg2FileMap);

  // 2. Build BOOT1 (PK21 embeds KIP1 SHA-256 hashes; STG2 pins PK21 SHA-256)
  const package2Bytes = buildStage2Package2Binary(kipFiles);
  const stage2HdrBytes = buildStage2Header(package2Bytes, kipFiles.length);
  const boot1Image = packNxfs({
    '/pk21/package2.bin': package2Bytes,
    '/pk21/stage2.hdr': stage2HdrBytes,
  });

  // 3. Build Stage 1 (NX_BOOT1 pins PK21 SHA-256; STG1 pins NX_BOOT1 SHA-256)
  const nxBoot1Bytes = buildStage1Binary(package2Bytes);
  const stage1HdrBytes = buildStage1Header(nxBoot1Bytes);

  // 4. Build PRODINFO (KB00 pins NX_BOOT1 & PK21 SHA-256 digests + master key hashes)
  const keyblobBytes = buildKeyblobBinary(DEFAULT_PRODINFO, nxBoot1Bytes, package2Bytes);
  const prodInfoImage = packNxfs({
    '/cal/prodinfo.bin': encodeCal0(DEFAULT_PRODINFO),
    '/cal/cal0_keyblob.bin': keyblobBytes,
    '/cal/touch_cal.bin': buildTouchCalBinary(),
    '/cal/audio_cal.bin': buildAudioCalBinary(),
    '/cal/imu_cal.bin': buildImuCalBinary(),
  });

  // 5. Build BOOT0 (BCT0 pins KB00 SHA-256 + NX_BOOT1 SHA-256 + serial hint)
  const bctBytes = buildBctBinary(DEFAULT_PRODINFO, nxBoot1Bytes, keyblobBytes);
  const boot0Image = packNxfs({
    '/boot/bct.bin': bctBytes,
    '/boot/nx_boot1.bin': nxBoot1Bytes,
    '/boot/stage1.hdr': stage1HdrBytes,
  });

  // 6. Build PRODINFOF
  const prodInfoFImage = packNxfs({
    '/factory/rail_cal.bin': buildFactoryRailCal(),
    '/factory/battery_profile.bin': buildBatteryProfileBinary(),
  });

  // 7. Build SAFE
  const safeImage = packNxfs({
    '/safe/recovery.bin': buildSafeRecoveryBinary(),
    '/safe/recovery_ui.bin': buildRecoveryUiBinary(),
  });

  // 8. Build SYSTEM (Manifests, Themes, Audio, Artwork Images, Sprites, NRO0 & NXVM Code, Game Assets)
  const systemImage = packNxfs({
    '/sys/os_manifest.bin': encodeHosm(DEFAULT_OS_MANIFEST),
    '/sys/themes/basic_white.bin': encodeThm0(DEFAULT_LIGHT_THEME),
    '/sys/themes/basic_black.bin': encodeThm0(DEFAULT_DARK_THEME),
    '/sys/sound/ui_sfx_table.bin': encodeSfx0(DEFAULT_SFX_TABLE),
    '/sys/sound/boot_chime.bin': buildBootChimeBinary(),
    '/sys/applets/qlaunch.bin': buildQlaunchHeader(),
    '/sys/news/bulletin.bin': encodeNws0(DEFAULT_NEWS),
    '/sys/eshop/catalog.bin': encodeEsh0(DEFAULT_ESHOP_CATALOG),
    '/sys/eshop/title-trivia.pkg': buildQuizPackageBinary(),
    '/sys/locale/strings.bin': buildSystemStringsBinary(),
    '/sys/caps/capabilities.bin': buildCapabilitiesBinary(),
    '/sys/assets/artwork_pack.bin': buildArtworkPackBinary(),
    '/sys/assets/avatar_glyphs.bin': buildAvatarGlyphsBinary(),
    '/sys/assets/boot_splash.bin': buildBootSplashBinary(),
    '/sys/assets/ui_sprites.bin': buildSpriteAtlasBinary(),
    '/sys/code/qlaunch.nro': buildQlaunchNroBinary(),
    '/sys/code/battery_policy.nxb': buildBatteryPolicyVmBinary(),
    '/sys/code/stellar_data.bin': buildStellarDataBinary(),
    '/sys/code/tetromino_data.bin': buildTetrominoDataBinary(),
    '/sys/code/chromatic_data.bin': buildChromaticDataBinary(),
  });

  // 9. Build USER (1:1 synchronized binary SAVE files derived directly from DEFAULT_TITLES)
  const userFileMap: Record<string, Uint8Array> = {
    '/user/save/settings.bin': encodeSet0(DEFAULT_SETTINGS),
    '/user/save/profiles.bin': encodePrf0(DEFAULT_PROFILES),
    '/user/titles/registry.bin': encodeTit0(DEFAULT_TITLES),
    '/user/album/captures.bin': encodeAlb0(DEFAULT_ALBUM),
  };
  for (const t of DEFAULT_TITLES) {
    userFileMap[t.saveFilePath] = buildGameSaveBinary(
      t.id,
      t.highScore ?? 0,
      t.playMinutes,
      t.lastPlayed,
      t.highScore !== undefined,
      DEFAULT_SETTINGS.activeUserId
    );
  }
  const userImage = packNxfs(userFileMap);

  // Exact contiguous GPT eMMC 512-byte sector layout:
  // Every partition satisfies (endLba - startLba + 1) * 512 === virtualCapacityBytes
  // and stores decrypted NXFS v2 partition images (encrypted: false).
  return [
    {
      id: 'BOOT0',
      gptIndex: 0,
      label: 'BOOT0 (eMMC Boot Area 0)',
      description: 'BCT0 DRAM parameters & Stage 1 Bootloader (NX_BOOT1)',
      requiredBy: 'STAGE1',
      virtualCapacityBytes: 4 * 1024 * 1024, // 8192 * 512
      encrypted: false,
      startLba: 0,
      endLba: 8191,
      image: boot0Image,
    },
    {
      id: 'BOOT1',
      gptIndex: 1,
      label: 'BOOT1 (eMMC Boot Area 1)',
      description: 'Stage 2 Bootloader (PK21 / package2) binary image',
      requiredBy: 'STAGE2',
      virtualCapacityBytes: 4 * 1024 * 1024, // 8192 * 512
      encrypted: false,
      startLba: 8192,
      endLba: 16383,
      image: boot1Image,
    },
    {
      id: 'PRODINFO',
      gptIndex: 2,
      label: 'PRODINFO (Calibration · Decrypted)',
      description: 'CAL0 serial/region/fuses, KB00 keys & hardware sensor calibration',
      requiredBy: 'STAGE1',
      virtualCapacityBytes: 4 * 1024 * 1024, // 8192 * 512
      encrypted: false,
      startLba: 16384,
      endLba: 24575,
      image: prodInfoImage,
    },
    {
      id: 'PRODINFOF',
      gptIndex: 3,
      label: 'PRODINFOF (Factory · Decrypted)',
      description: 'FCA0 rail calibration & BAT0 battery fuel-gauge profile',
      requiredBy: 'STAGE2',
      virtualCapacityBytes: 4 * 1024 * 1024, // 8192 * 512
      encrypted: false,
      startLba: 24576,
      endLba: 32767,
      image: prodInfoFImage,
    },
    {
      id: 'BCPKG2',
      gptIndex: 4,
      label: 'BCPKG2-1-Normal-Main',
      description: 'Kernel Initial Processes (fs, loader, sm, pm, hid, am, nvdrv)',
      requiredBy: 'STAGE2',
      virtualCapacityBytes: 8 * 1024 * 1024, // 16384 * 512
      encrypted: false,
      startLba: 32768,
      endLba: 49151,
      image: bcpkg2Image,
    },
    {
      id: 'SAFE',
      gptIndex: 5,
      label: 'SAFE (Recovery · Decrypted)',
      description: 'Maintenance Mode recovery descriptor & UI options',
      requiredBy: 'STAGE2',
      virtualCapacityBytes: 64 * 1024 * 1024, // 131072 * 512
      encrypted: false,
      startLba: 49152,
      endLba: 180223,
      image: safeImage,
    },
    {
      id: 'SYSTEM',
      gptIndex: 6,
      label: 'SYSTEM (Horizon-NX OS · Decrypted)',
      description: 'HOSM manifest, THM0 themes, SFX0 audio, CAP0, STR0 & qlaunch',
      requiredBy: 'OS_HOME',
      virtualCapacityBytes: 2560 * 1024 * 1024, // 5242880 * 512
      encrypted: false,
      startLba: 180224,
      endLba: 5423103,
      image: systemImage,
    },
    {
      id: 'USER',
      gptIndex: 7,
      label: 'USER (User Data & Saves · Decrypted)',
      description: 'SET0 settings, PRF0 profiles, TIT0 registry, SAVE files & ALB0 album',
      requiredBy: 'OS_HOME',
      virtualCapacityBytes: 26 * 1024 * 1024 * 1024, // 54525952 * 512
      encrypted: false,
      startLba: 5423104,
      endLba: 59949055,
      image: userImage,
    },
  ];
}
