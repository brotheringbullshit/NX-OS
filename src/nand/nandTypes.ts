export type PartitionId =
  | 'BOOT0'
  | 'BOOT1'
  | 'PRODINFO'
  | 'PRODINFOF'
  | 'BCPKG2'
  | 'SAFE'
  | 'SYSTEM'
  | 'USER';

export interface NandPartitionMeta {
  id: PartitionId;
  gptIndex: number;
  label: string;
  description: string;
  requiredBy: 'STAGE1' | 'STAGE2' | 'OS_HOME';
  virtualCapacityBytes: number;
  chunkSize: number;
  chunkCount: number;
  usedBytes: number;
  partitionCrc32: number;
  sha256: string;
  encrypted: boolean;
  startLba: number;
  endLba: number;
  updatedAt: number;
}

export interface NandChunkRecord {
  key: string; // `${partitionId}:${chunkIndex}`
  partitionId: PartitionId;
  chunkIndex: number;
  data: Uint8Array;
  byteLength: number;
  crc32: number;
  writtenAt: number;
}

export interface NandIoEvent {
  id: number;
  timestamp: number;
  op: 'READ' | 'WRITE' | 'VERIFY' | 'FLASH' | 'CORRUPT';
  partitionId: PartitionId;
  chunkRange: string;
  bytes: number;
  crcOk: boolean;
  detail: string;
}

export interface NxfsFileEntry {
  path: string;
  offset: number;
  length: number;
  crc32: number;
}

export interface ProdInfoPayload {
  magic: 'CAL0';
  serial: string;
  sku: 'HAC-001' | 'HAC-001(-01)' | 'HEG-001';
  region: 'USA' | 'JPN' | 'EUR';
  macAddress: string;
  fuseCount: number;
  boardRevision: string;
  masterKeyHash: string;
  lcdProfile: string;
}

export interface SystemOsManifest {
  osVersion: string;
  codename: string;
  buildHash: string;
  kernelEntry: string;
  requiredKips: string[];
  homeAppletId: string;
  splashColor: string;
  splashAccent: string;
}

export interface SwitchThemeTokens {
  id: 'light' | 'dark';
  name: string;
  bgCanvas: string;
  bgHeader: string;
  bgTile: string;
  bgTileEmpty: string;
  bgAppletBtn: string;
  bgModal: string;
  textPrimary: string;
  textSecondary: string;
  borderHairline: string;
  focusCyan: string;
}

export interface UiSfxParam {
  freq: number;
  freqEnd?: number;
  durationMs: number;
  type: 'sine' | 'triangle' | 'square';
  gain: number;
}

export type UiSfxTable = Record<
  'tick' | 'select' | 'back' | 'launch' | 'click' | 'modal' | 'error' | 'sleep',
  UiSfxParam
>;

export interface ConsoleSettings {
  nickname: string;
  theme: 'light' | 'dark';
  clock24h: boolean;
  airplaneMode: boolean;
  wifiSsid: string;
  brightness: number; // 30..100
  volume: number; // 0..100
  muted: boolean;
  autoSleepMinutes: number;
  activeUserId: string;
  dockedMode: boolean;
}

export interface UserProfile {
  id: string;
  name: string;
  avatarBg: string;
  avatarGlyph: 'star' | 'gamepad' | 'flame' | 'leaf';
  playHoursTotal: number;
  friendCode: string;
}

export interface InstalledTitle {
  id: string;
  title: string;
  publisher: string;
  version: string;
  category: 'game' | 'homebrew' | 'tool' | 'cartridge';
  artworkId: string;
  runnerType: 'stellar' | 'blocks' | 'chromatic' | 'hex' | 'sketch' | 'cartridge' | 'trivia';
  sizeMb: number;
  playMinutes: number;
  lastPlayed: number;
  highScore?: number;
  saveFilePath: string;
  pinnedOrder: number;
  isGameCard?: boolean;
}

export interface AlbumCapture {
  id: string;
  title: string;
  gameTitle: string;
  capturedAt: number;
  dataUrl: string; // rendered canvas PNG or SVG capture
}

export interface NewsArticle {
  id: string;
  channel: string;
  title: string;
  date: string;
  summary: string;
  body: string;
  accentColor: string;
}

export interface EshopListing {
  id: string;
  title: string;
  publisher: string;
  version: string;
  category: 'game' | 'homebrew' | 'tool';
  artworkId: string;
  runnerType: InstalledTitle['runnerType'];
  sizeMb: number;
  priceLabel: string;
  description: string;
}

export interface BootLogLine {
  stage: 'ROM' | 'STAGE1' | 'STAGE2' | 'KERNEL' | 'HOS';
  level: 'INFO' | 'OK' | 'WARN' | 'ERR';
  text: string;
  partition?: PartitionId;
  chunkInfo?: string;
}

export interface BootFailure {
  stage: 'STAGE1' | 'STAGE2' | 'HOS';
  code: string;
  title: string;
  partition: PartitionId;
  reason: string;
  logs: BootLogLine[];
}

export interface QlaunchConfig {
  gridSlots: number;
  systemApplets: number;
  titleId: string;
  name: string;
}

export interface SystemCapability {
  titleId: string;
  flags: number;
  name: string;
}

export interface BatteryProfile {
  model: string;
  capacityMah: number;
  wattHours: number;
  nominalMv: number;
  maxChargeMv: number;
  cutoffMv: number;
  factoryCycles: number;
  internalResistanceMohm: number;
}

export interface HardwareCalibration {
  touch: {
    width: number;
    height: number;
    maxPoints: number;
    jitterFilter: boolean;
  };
  audio: {
    codec: string;
    headphoneLimitDb: number;
    speakerBoostGainDb: number;
    noiseCancellation: boolean;
  };
  imu: {
    sensor: string;
    accelZeroG: [number, number, number];
    gyroDrift: [number, number, number];
  };
  railModel: string;
  battery: BatteryProfile;
}

export interface SpriteBitmap {
  id: string;
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface BootChimeNote {
  freqHz: number;
  startMs: number;
  durationMs: number;
  wave: 'sine' | 'triangle' | 'square';
  gain: number;
}

export interface BootSplashAsset {
  caption: string;
  bgColor: string;
  accentColor: string;
  dataUrl: string;
}

export interface StellarGameConfig {
  shipSpeed: number;
  bulletSpeed: number;
  fireIntervalTicks: number;
  spawnIntervalTicks: number;
  pointsPerRock: number;
  bgColor: string;
  bulletColor: string;
}

export interface TetrominoDef {
  name: string;
  color: string;
  cells: number[][];
}

export interface TetrominoGameConfig {
  dropIntervalMs: number;
  lockBonus: number;
  lineScore: number;
  shapes: TetrominoDef[];
}

export interface ChromaticPadDef {
  id: number;
  label: string;
  color: string;
  freqHz: number;
  durationMs: number;
}

export interface QuizQuestion {
  q: string;
  opts: string[];
  ans: number;
}

export interface QuizPackage {
  titleId: string;
  title: string;
  version: string;
  pointsPerCorrect: number;
  questions: QuizQuestion[];
}

export interface NroProgramHeader {
  magic: 'NRO0';
  titleId: string;
  name: string;
  entryAddr: number;
  textSize: number;
  rodataSize: number;
  dataSize: number;
  textCrc32: number;
  arm64Opcodes: number[];
  symbols: string[];
}

export interface VmTelemetryResult {
  batteryPercent: number;
  estimatedMinutesLeft: number;
  healthPercent: number;
  instructionsExecuted: number;
  programSha256: string;
}

export interface BootedSystemContext {
  prodInfo: ProdInfoPayload;
  osManifest: SystemOsManifest;
  themes: {
    light: SwitchThemeTokens;
    dark: SwitchThemeTokens;
  };
  sfxTable: UiSfxTable;
  localeStrings: Record<string, string>;
  qlaunchConfig: QlaunchConfig;
  capabilities: SystemCapability[];
  hardwareCal: HardwareCalibration;
  artworkImages: Record<string, string>;
  avatarGlyphs: Record<string, string>;
  bootSplash: BootSplashAsset;
  spriteAtlas: Record<string, SpriteBitmap>;
  bootChime: BootChimeNote[];
  stellarConfig: StellarGameConfig;
  tetrominoConfig: TetrominoGameConfig;
  chromaticPads: ChromaticPadDef[];
  quizPackage: QuizPackage | null;
  qlaunchNro: NroProgramHeader;
  batteryTelemetry: VmTelemetryResult;
  settings: ConsoleSettings;
  profiles: UserProfile[];
  titles: InstalledTitle[];
  news: NewsArticle[];
  eshopCatalog: EshopListing[];
  album: AlbumCapture[];
  kipsLoaded: string[];
  bootLogs: BootLogLine[];
  totalChunksRead: number;
  totalBytesRead: number;
  bootDurationMs: number;
}

export interface NandAuditCheck {
  id: string;
  category:
    | 'GPT'
    | 'CHUNKS'
    | 'BOOT0'
    | 'PRODINFO'
    | 'BOOT1'
    | 'PRODINFOF'
    | 'BCPKG2'
    | 'SAFE'
    | 'SYSTEM'
    | 'USER';
  label: string;
  passed: boolean;
  detail: string;
}

export interface NandAuditReport {
  timestamp: number;
  allPassed: boolean;
  passedCount: number;
  totalCount: number;
  checks: NandAuditCheck[];
}
