import { crc32 } from './crc32';
import {
  AlbumCapture,
  BatteryProfile,
  ConsoleSettings,
  EshopListing,
  HardwareCalibration,
  InstalledTitle,
  NewsArticle,
  ProdInfoPayload,
  QlaunchConfig,
  SwitchThemeTokens,
  SystemCapability,
  SystemOsManifest,
  UiSfxParam,
  UiSfxTable,
  UserProfile,
} from './nandTypes';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ============================================================================
// Low-level Binary Stream Writer & Reader
// ============================================================================
export class BinaryWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialCapacity = 512) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number) {
    if (this.pos + extra <= this.buf.length) return;
    let nextCap = this.buf.length * 2;
    while (nextCap < this.pos + extra) nextCap *= 2;
    const next = new Uint8Array(nextCap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  public writeMagic(magic: string) {
    const b = encoder.encode(magic);
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  public writeU8(v: number) {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  public writeU16(v: number) {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }

  public writeU32(v: number) {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }

  public writeF32(v: number) {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  public writeF64(v: number) {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  public writeBytes(bytes: Uint8Array) {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  public writeFixedString(str: string, width: number) {
    this.ensure(width);
    const encoded = encoder.encode(str);
    const slice = encoded.subarray(0, width);
    this.buf.fill(0, this.pos, this.pos + width);
    this.buf.set(slice, this.pos);
    this.pos += width;
  }

  public writeVarString(str: string) {
    const encoded = encoder.encode(str);
    this.writeU32(encoded.length);
    this.writeBytes(encoded);
  }

  public writeRgbHex(hex: string) {
    const clean = hex.replace('#', '').padEnd(6, '0');
    this.writeU8(parseInt(clean.slice(0, 2), 16) || 0);
    this.writeU8(parseInt(clean.slice(2, 4), 16) || 0);
    this.writeU8(parseInt(clean.slice(4, 6), 16) || 0);
  }

  public finishWithCrc32(): Uint8Array {
    const payload = this.buf.subarray(0, this.pos);
    const c = crc32(payload);
    this.writeU32(c);
    return this.buf.slice(0, this.pos);
  }

  public finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export class BinaryReader {
  private view: DataView;
  public pos = 0;

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  public readMagic(len = 4): string {
    const s = decoder.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  public readU8(): number {
    return this.buf[this.pos++];
  }

  public readU16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  public readU32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  public readF32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  public readF64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  public readBytes(len: number): Uint8Array {
    const s = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  public readFixedString(width: number): string {
    const slice = this.buf.subarray(this.pos, this.pos + width);
    this.pos += width;
    const zeroIdx = slice.indexOf(0);
    return decoder.decode(zeroIdx >= 0 ? slice.subarray(0, zeroIdx) : slice);
  }

  public readVarString(): string {
    const len = this.readU32();
    const s = decoder.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  public readRgbHex(): string {
    const r = this.readU8().toString(16).padStart(2, '0').toUpperCase();
    const g = this.readU8().toString(16).padStart(2, '0').toUpperCase();
    const b = this.readU8().toString(16).padStart(2, '0').toUpperCase();
    return `#${r}${g}${b}`;
  }
}

export function verifyTrailingCrc32(bytes: Uint8Array, label: string): void {
  if (bytes.length < 8) {
    throw new Error(`${label} binary struct truncated (< 8 bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stored = view.getUint32(bytes.length - 4, true);
  const actual = crc32(bytes.subarray(0, bytes.length - 4));
  if (stored !== actual) {
    throw new Error(`${label} binary CRC32 verification failed`);
  }
}

// ============================================================================
// 1. PRODINFO (CAL0) Binary Struct
// ============================================================================
const REGION_CODES: ProdInfoPayload['region'][] = ['USA', 'JPN', 'EUR'];
const SKU_CODES: ProdInfoPayload['sku'][] = ['HAC-001', 'HAC-001(-01)', 'HEG-001'];

export function encodeCal0(p: ProdInfoPayload): Uint8Array {
  const w = new BinaryWriter(256);
  w.writeMagic('CAL0');
  w.writeU16(1); // struct version
  w.writeU8(p.fuseCount);
  w.writeU8(Math.max(0, REGION_CODES.indexOf(p.region)));
  w.writeU8(Math.max(0, SKU_CODES.indexOf(p.sku)));
  // MAC address 6 raw bytes
  const macParts = p.macAddress.split(':').map((h) => parseInt(h, 16) || 0);
  for (let i = 0; i < 6; i++) w.writeU8(macParts[i] ?? 0);
  w.writeFixedString(p.serial, 24);
  w.writeFixedString(p.boardRevision, 20);
  w.writeFixedString(p.masterKeyHash, 32);
  w.writeFixedString(p.lcdProfile, 32);
  return w.finishWithCrc32();
}

export function decodeCal0(bytes: Uint8Array): ProdInfoPayload {
  verifyTrailingCrc32(bytes, 'PRODINFO CAL0');
  const r = new BinaryReader(bytes);
  const magic = r.readMagic(4);
  if (magic !== 'CAL0') throw new Error(`Invalid PRODINFO magic "${magic}"`);
  r.readU16(); // version
  const fuseCount = r.readU8();
  const regionIdx = r.readU8();
  const skuIdx = r.readU8();
  const macBytes: string[] = [];
  for (let i = 0; i < 6; i++) {
    macBytes.push(r.readU8().toString(16).toUpperCase().padStart(2, '0'));
  }
  const serial = r.readFixedString(24);
  const boardRevision = r.readFixedString(20);
  const masterKeyHash = r.readFixedString(32);
  const lcdProfile = r.readFixedString(32);
  return {
    magic: 'CAL0',
    serial,
    sku: SKU_CODES[skuIdx] ?? 'HAC-001(-01)',
    region: REGION_CODES[regionIdx] ?? 'USA',
    macAddress: macBytes.join(':'),
    fuseCount,
    boardRevision,
    masterKeyHash,
    lcdProfile,
  };
}

// ============================================================================
// 2. SYSTEM OS Manifest (HOSM) Binary Struct
// ============================================================================
export function encodeHosm(m: SystemOsManifest): Uint8Array {
  const w = new BinaryWriter(512);
  w.writeMagic('HOSM');
  const [maj, min, pat] = m.osVersion.split('.').map((n) => parseInt(n, 10) || 0);
  w.writeU8(maj);
  w.writeU8(min);
  w.writeU8(pat);
  w.writeU8(m.requiredKips.length);
  w.writeFixedString(m.codename, 24);
  w.writeFixedString(m.buildHash, 24);
  w.writeU32(parseInt(m.kernelEntry, 16) >>> 0);
  w.writeFixedString(m.homeAppletId, 20);
  w.writeRgbHex(m.splashColor);
  w.writeRgbHex(m.splashAccent);
  for (const kip of m.requiredKips) {
    w.writeFixedString(kip, 16);
  }
  return w.finishWithCrc32();
}

export function decodeHosm(bytes: Uint8Array): SystemOsManifest {
  verifyTrailingCrc32(bytes, 'SYSTEM HOSM');
  const r = new BinaryReader(bytes);
  const magic = r.readMagic(4);
  if (magic !== 'HOSM') throw new Error(`Invalid OS manifest magic "${magic}"`);
  const maj = r.readU8();
  const min = r.readU8();
  const pat = r.readU8();
  const kipCount = r.readU8();
  const codename = r.readFixedString(24);
  const buildHash = r.readFixedString(24);
  const kernelEntry = '0x' + r.readU32().toString(16).toUpperCase().padStart(8, '0');
  const homeAppletId = r.readFixedString(20);
  const splashColor = r.readRgbHex();
  const splashAccent = r.readRgbHex();
  const requiredKips: string[] = [];
  for (let i = 0; i < kipCount; i++) {
    requiredKips.push(r.readFixedString(16));
  }
  return {
    osVersion: `${maj}.${min}.${pat}`,
    codename,
    buildHash,
    kernelEntry,
    requiredKips,
    homeAppletId,
    splashColor,
    splashAccent,
  };
}

// ============================================================================
// 3. SYSTEM Theme Palette (THM0) Binary Struct
// ============================================================================
export function encodeThm0(t: SwitchThemeTokens): Uint8Array {
  const w = new BinaryWriter(128);
  w.writeMagic('THM0');
  w.writeU8(t.id === 'dark' ? 1 : 0);
  w.writeFixedString(t.name, 24);
  w.writeRgbHex(t.bgCanvas);
  w.writeRgbHex(t.bgHeader);
  w.writeRgbHex(t.bgTile);
  w.writeRgbHex(t.bgTileEmpty);
  w.writeRgbHex(t.bgAppletBtn);
  w.writeRgbHex(t.bgModal);
  w.writeRgbHex(t.textPrimary);
  w.writeRgbHex(t.textSecondary);
  w.writeRgbHex(t.borderHairline);
  w.writeRgbHex(t.focusCyan);
  return w.finishWithCrc32();
}

export function decodeThm0(bytes: Uint8Array): SwitchThemeTokens {
  verifyTrailingCrc32(bytes, 'SYSTEM THM0');
  const r = new BinaryReader(bytes);
  const magic = r.readMagic(4);
  if (magic !== 'THM0') throw new Error(`Invalid theme binary magic "${magic}"`);
  const id = r.readU8() === 1 ? 'dark' : 'light';
  const name = r.readFixedString(24);
  return {
    id,
    name,
    bgCanvas: r.readRgbHex(),
    bgHeader: r.readRgbHex(),
    bgTile: r.readRgbHex(),
    bgTileEmpty: r.readRgbHex(),
    bgAppletBtn: r.readRgbHex(),
    bgModal: r.readRgbHex(),
    textPrimary: r.readRgbHex(),
    textSecondary: r.readRgbHex(),
    borderHairline: r.readRgbHex(),
    focusCyan: r.readRgbHex(),
  };
}

// ============================================================================
// 4. SYSTEM UI SFX Synthesis Table (SFX0) Binary Struct
// ============================================================================
const SFX_KEYS: (keyof UiSfxTable)[] = [
  'tick',
  'select',
  'back',
  'launch',
  'click',
  'modal',
  'error',
  'sleep',
];
const WAVE_TYPES: UiSfxParam['type'][] = ['sine', 'triangle', 'square'];

export function encodeSfx0(table: UiSfxTable): Uint8Array {
  const w = new BinaryWriter(128);
  w.writeMagic('SFX0');
  w.writeU8(SFX_KEYS.length);
  for (const key of SFX_KEYS) {
    const p = table[key];
    w.writeU16(p.freq);
    w.writeU16(p.freqEnd ?? p.freq);
    w.writeU16(p.durationMs);
    w.writeU8(Math.max(0, WAVE_TYPES.indexOf(p.type)));
    w.writeU8(Math.round(p.gain * 1000));
  }
  return w.finishWithCrc32();
}

export function decodeSfx0(bytes: Uint8Array): UiSfxTable {
  verifyTrailingCrc32(bytes, 'SYSTEM SFX0');
  const r = new BinaryReader(bytes);
  const magic = r.readMagic(4);
  if (magic !== 'SFX0') throw new Error(`Invalid SFX table magic "${magic}"`);
  const count = r.readU8();
  const out = {} as UiSfxTable;
  for (let i = 0; i < count && i < SFX_KEYS.length; i++) {
    const freq = r.readU16();
    const freqEnd = r.readU16();
    const durationMs = r.readU16();
    const waveIdx = r.readU8();
    const gainMilli = r.readU8();
    out[SFX_KEYS[i]] = {
      freq,
      freqEnd,
      durationMs,
      type: WAVE_TYPES[waveIdx] ?? 'sine',
      gain: gainMilli / 1000,
    };
  }
  return out;
}

// ============================================================================
// 5. SYSTEM News (NWS0) & eShop Catalog (ESH0) Binary Records
// ============================================================================
export function encodeNws0(items: NewsArticle[]): Uint8Array {
  const w = new BinaryWriter(2048);
  w.writeMagic('NWS0');
  w.writeU16(items.length);
  for (const item of items) {
    w.writeVarString(item.id);
    w.writeVarString(item.channel);
    w.writeVarString(item.title);
    w.writeVarString(item.date);
    w.writeVarString(item.summary);
    w.writeVarString(item.body);
    w.writeRgbHex(item.accentColor);
  }
  return w.finishWithCrc32();
}

export function decodeNws0(bytes: Uint8Array): NewsArticle[] {
  verifyTrailingCrc32(bytes, 'SYSTEM NWS0');
  const r = new BinaryReader(bytes);
  const magic = r.readMagic(4);
  if (magic !== 'NWS0') throw new Error(`Invalid News binary magic "${magic}"`);
  const count = r.readU16();
  const items: NewsArticle[] = [];
  for (let i = 0; i < count; i++) {
    items.push({
      id: r.readVarString(),
      channel: r.readVarString(),
      title: r.readVarString(),
      date: r.readVarString(),
      summary: r.readVarString(),
      body: r.readVarString(),
      accentColor: r.readRgbHex(),
    });
  }
  return items;
}

const CAT_ENUM: InstalledTitle['category'][] = ['game', 'homebrew', 'tool', 'cartridge'];
const RUNNER_ENUM: InstalledTitle['runnerType'][] = [
  'stellar',
  'blocks',
  'chromatic',
  'hex',
  'sketch',
  'cartridge',
  'trivia',
];

export function encodeEsh0(items: EshopListing[]): Uint8Array {
  const w = new BinaryWriter(1024);
  w.writeMagic('ESH0');
  w.writeU16(items.length);
  for (const item of items) {
    w.writeVarString(item.id);
    w.writeVarString(item.title);
    w.writeVarString(item.publisher);
    w.writeVarString(item.version);
    w.writeU8(Math.max(0, CAT_ENUM.indexOf(item.category)));
    w.writeVarString(item.artworkId);
    w.writeU8(Math.max(0, RUNNER_ENUM.indexOf(item.runnerType)));
    w.writeU32(item.sizeMb);
    w.writeVarString(item.priceLabel);
    w.writeVarString(item.description);
  }
  return w.finishWithCrc32();
}

export function decodeEsh0(bytes: Uint8Array): EshopListing[] {
  verifyTrailingCrc32(bytes, 'SYSTEM ESH0');
  const r = new BinaryReader(bytes);
  const magic = r.readMagic(4);
  if (magic !== 'ESH0') throw new Error(`Invalid eShop binary magic "${magic}"`);
  const count = r.readU16();
  const items: EshopListing[] = [];
  for (let i = 0; i < count; i++) {
    const id = r.readVarString();
    const title = r.readVarString();
    const publisher = r.readVarString();
    const version = r.readVarString();
    const catIdx = r.readU8();
    const artworkId = r.readVarString();
    const runnerIdx = r.readU8();
    const sizeMb = r.readU32();
    const priceLabel = r.readVarString();
    const description = r.readVarString();
    items.push({
      id,
      title,
      publisher,
      version,
      category: (CAT_ENUM[catIdx] as EshopListing['category']) ?? 'game',
      artworkId,
      runnerType: RUNNER_ENUM[runnerIdx] ?? 'stellar',
      sizeMb,
      priceLabel,
      description,
    });
  }
  return items;
}

// ============================================================================
// 6. USER Settings (SET0), Profiles (PRF0), Titles (TIT0), Album (ALB0)
// ============================================================================
export function encodeSet0(s: ConsoleSettings): Uint8Array {
  const w = new BinaryWriter(128);
  w.writeMagic('SET0');
  w.writeU8(s.theme === 'dark' ? 1 : 0);
  w.writeU8(s.clock24h ? 1 : 0);
  w.writeU8(s.airplaneMode ? 1 : 0);
  w.writeU8(s.brightness);
  w.writeU8(s.volume);
  w.writeU8(s.muted ? 1 : 0);
  w.writeU8(s.autoSleepMinutes);
  w.writeU8(s.dockedMode ? 1 : 0);
  w.writeFixedString(s.nickname, 32);
  w.writeFixedString(s.wifiSsid, 32);
  w.writeFixedString(s.activeUserId, 16);
  return w.finishWithCrc32();
}

export function decodeSet0(bytes: Uint8Array): ConsoleSettings {
  verifyTrailingCrc32(bytes, 'USER SET0');
  const r = new BinaryReader(bytes);
  const magic = r.readMagic(4);
  if (magic !== 'SET0') throw new Error(`Invalid settings binary magic "${magic}"`);
  return {
    theme: r.readU8() === 1 ? 'dark' : 'light',
    clock24h: r.readU8() === 1,
    airplaneMode: r.readU8() === 1,
    brightness: r.readU8(),
    volume: r.readU8(),
    muted: r.readU8() === 1,
    autoSleepMinutes: r.readU8(),
    dockedMode: r.readU8() === 1,
    nickname: r.readFixedString(32),
    wifiSsid: r.readFixedString(32),
    activeUserId: r.readFixedString(16),
  };
}

const GLYPHS: UserProfile['avatarGlyph'][] = ['star', 'gamepad', 'flame', 'leaf'];

export function encodePrf0(profiles: UserProfile[]): Uint8Array {
  const w = new BinaryWriter(256);
  w.writeMagic('PRF0');
  w.writeU16(profiles.length);
  for (const p of profiles) {
    w.writeFixedString(p.id, 16);
    w.writeFixedString(p.name, 24);
    w.writeRgbHex(p.avatarBg);
    w.writeU8(Math.max(0, GLYPHS.indexOf(p.avatarGlyph)));
    w.writeU32(p.playHoursTotal);
    w.writeFixedString(p.friendCode, 20);
  }
  return w.finishWithCrc32();
}

export function decodePrf0(bytes: Uint8Array): UserProfile[] {
  verifyTrailingCrc32(bytes, 'USER PRF0');
  const r = new BinaryReader(bytes);
  const magic = r.readMagic(4);
  if (magic !== 'PRF0') throw new Error(`Invalid profiles binary magic "${magic}"`);
  const count = r.readU16();
  const out: UserProfile[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: r.readFixedString(16),
      name: r.readFixedString(24),
      avatarBg: r.readRgbHex(),
      avatarGlyph: GLYPHS[r.readU8()] ?? 'gamepad',
      playHoursTotal: r.readU32(),
      friendCode: r.readFixedString(20),
    });
  }
  return out;
}

export function encodeTit0(titles: InstalledTitle[]): Uint8Array {
  const w = new BinaryWriter(1024);
  w.writeMagic('TIT0');
  w.writeU16(titles.length);
  for (const t of titles) {
    w.writeVarString(t.id);
    w.writeVarString(t.title);
    w.writeVarString(t.publisher);
    w.writeVarString(t.version);
    w.writeU8(Math.max(0, CAT_ENUM.indexOf(t.category)));
    w.writeVarString(t.artworkId);
    w.writeU8(Math.max(0, RUNNER_ENUM.indexOf(t.runnerType)));
    w.writeU32(t.sizeMb);
    w.writeU32(t.playMinutes);
    w.writeF64(t.lastPlayed);
    w.writeU8(t.highScore !== undefined ? 1 : 0);
    w.writeU32(t.highScore ?? 0);
    w.writeVarString(t.saveFilePath);
    w.writeU16(t.pinnedOrder);
    w.writeU8(t.isGameCard ? 1 : 0);
  }
  return w.finishWithCrc32();
}

export function decodeTit0(bytes: Uint8Array): InstalledTitle[] {
  verifyTrailingCrc32(bytes, 'USER TIT0');
  const r = new BinaryReader(bytes);
  const magic = r.readMagic(4);
  if (magic !== 'TIT0') throw new Error(`Invalid title registry magic "${magic}"`);
  const count = r.readU16();
  const list: InstalledTitle[] = [];
  for (let i = 0; i < count; i++) {
    const id = r.readVarString();
    const title = r.readVarString();
    const publisher = r.readVarString();
    const version = r.readVarString();
    const catIdx = r.readU8();
    const artworkId = r.readVarString();
    const runIdx = r.readU8();
    const sizeMb = r.readU32();
    const playMinutes = r.readU32();
    const lastPlayed = r.readF64();
    const hasHighScore = r.readU8() === 1;
    const highScoreVal = r.readU32();
    const saveFilePath = r.readVarString();
    const pinnedOrder = r.readU16();
    const isGameCard = r.readU8() === 1;
    list.push({
      id,
      title,
      publisher,
      version,
      category: CAT_ENUM[catIdx] ?? 'game',
      artworkId,
      runnerType: RUNNER_ENUM[runIdx] ?? 'stellar',
      sizeMb,
      playMinutes,
      lastPlayed,
      highScore: hasHighScore ? highScoreVal : undefined,
      saveFilePath,
      pinnedOrder,
      isGameCard,
    });
  }
  return list;
}

export function encodeAlb0(captures: AlbumCapture[]): Uint8Array {
  const w = new BinaryWriter(2048);
  w.writeMagic('ALB0');
  w.writeU16(captures.length);
  for (const c of captures) {
    w.writeVarString(c.id);
    w.writeVarString(c.title);
    w.writeVarString(c.gameTitle);
    w.writeF64(c.capturedAt);
    w.writeVarString(c.dataUrl);
  }
  return w.finishWithCrc32();
}

export function decodeAlb0(bytes: Uint8Array): AlbumCapture[] {
  verifyTrailingCrc32(bytes, 'USER ALB0');
  const r = new BinaryReader(bytes);
  const magic = r.readMagic(4);
  if (magic !== 'ALB0') throw new Error(`Invalid album binary magic "${magic}"`);
  const count = r.readU16();
  const out: AlbumCapture[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: r.readVarString(),
      title: r.readVarString(),
      gameTitle: r.readVarString(),
      capturedAt: r.readF64(),
      dataUrl: r.readVarString(),
    });
  }
  return out;
}

// ============================================================================
// 7. Calibration, Qlaunch, Strings & Capabilities Decoders
// ============================================================================
export function decodeTcal(bytes: Uint8Array): HardwareCalibration['touch'] {
  verifyTrailingCrc32(bytes, 'PRODINFO TCAL');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'TCAL') throw new Error('Invalid TCAL magic');
  const width = r.readU16();
  const height = r.readU16();
  const maxPoints = r.readU8();
  const jitterFilter = r.readU8() === 1;
  return { width, height, maxPoints, jitterFilter };
}

export function decodeAcal(bytes: Uint8Array): HardwareCalibration['audio'] {
  verifyTrailingCrc32(bytes, 'PRODINFO ACAL');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'ACAL') throw new Error('Invalid ACAL magic');
  const codec = r.readFixedString(8);
  const headphoneLimitDb = r.readU8();
  const speakerBoostGainDb = r.readU8();
  const noiseCancellation = r.readU8() === 1;
  return { codec, headphoneLimitDb, speakerBoostGainDb, noiseCancellation };
}

export function decodeIcal(bytes: Uint8Array): HardwareCalibration['imu'] {
  verifyTrailingCrc32(bytes, 'PRODINFO ICAL');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'ICAL') throw new Error('Invalid ICAL magic');
  const sensor = r.readFixedString(8);
  const ax = r.readF32();
  const ay = r.readF32();
  const az = r.readF32();
  const gx = r.readF32();
  const gy = r.readF32();
  const gz = r.readF32();
  return { sensor, accelZeroG: [ax, ay, az], gyroDrift: [gx, gy, gz] };
}

export function decodeFca0(bytes: Uint8Array): { railModel: string; mah: number; enabled: boolean } {
  verifyTrailingCrc32(bytes, 'PRODINFOF FCA0');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'FCA0') throw new Error('Invalid FCA0 magic');
  r.readF32();
  r.readF32();
  const mah = r.readU16();
  const enabled = r.readU8() === 1;
  const railModel = r.readFixedString(16);
  return { railModel, mah, enabled };
}

export function decodeBat0(bytes: Uint8Array): BatteryProfile {
  verifyTrailingCrc32(bytes, 'PRODINFOF BAT0');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'BAT0') throw new Error('Invalid BAT0 magic');
  const model = r.readFixedString(12);
  const capacityMah = r.readU16();
  const wattHours = r.readU16() / 10;
  const nominalMv = r.readU16();
  const maxChargeMv = r.readU16();
  const cutoffMv = r.readU16();
  const factoryCycles = r.readU16();
  const internalResistanceMohm = r.readU16();
  return {
    model,
    capacityMah,
    wattHours,
    nominalMv,
    maxChargeMv,
    cutoffMv,
    factoryCycles,
    internalResistanceMohm,
  };
}

export function decodeQapp(bytes: Uint8Array): QlaunchConfig {
  verifyTrailingCrc32(bytes, 'SYSTEM QAPP');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'QAPP') throw new Error('Invalid QAPP magic');
  const gridSlots = r.readU16();
  const systemApplets = r.readU16();
  const titleId = r.readFixedString(20);
  const name = r.readFixedString(16);
  return { gridSlots, systemApplets, titleId, name };
}

export function decodeStr0(bytes: Uint8Array): Record<string, string> {
  verifyTrailingCrc32(bytes, 'SYSTEM STR0');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'STR0') throw new Error('Invalid STR0 magic');
  const count = r.readU16();
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const key = r.readFixedString(16);
    const val = r.readVarString();
    out[key] = val;
  }
  return out;
}

export function decodeCap0(bytes: Uint8Array): SystemCapability[] {
  verifyTrailingCrc32(bytes, 'SYSTEM CAP0');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'CAP0') throw new Error('Invalid CAP0 magic');
  const count = r.readU16();
  const out: SystemCapability[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      titleId: r.readFixedString(20),
      flags: r.readU32(),
      name: r.readFixedString(24),
    });
  }
  return out;
}
