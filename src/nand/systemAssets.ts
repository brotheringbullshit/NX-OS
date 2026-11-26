import { BinaryReader, BinaryWriter, verifyTrailingCrc32 } from './binaryStructs';
import { crc32 } from './crc32';
import {
  BootChimeNote,
  BootSplashAsset,
  ChromaticPadDef,
  NroProgramHeader,
  QuizPackage,
  QuizQuestion,
  SpriteBitmap,
  StellarGameConfig,
  TetrominoDef,
  TetrominoGameConfig,
} from './nandTypes';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function svgBytesToDataUrl(bytes: Uint8Array): string {
  const svg = decoder.decode(bytes);
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

// ============================================================================
// 1. ART0: Box-Art Vector Images (/sys/assets/artwork_pack.bin)
// ============================================================================
const FACTORY_ARTWORK_SVGS: Record<string, { w: number; h: number; svg: string }> = {
  stellar: {
    w: 256,
    h: 256,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="st-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#08132B"/><stop offset="60%" stop-color="#122B5E"/><stop offset="100%" stop-color="#1B1040"/></linearGradient><linearGradient id="st-pl" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FF7A45"/><stop offset="100%" stop-color="#B81D4D"/></linearGradient></defs><rect width="256" height="256" fill="url(#st-bg)"/><circle cx="42" cy="48" r="2" fill="#fff" opacity="0.8"/><circle cx="96" cy="30" r="1.5" fill="#7DD3FC" opacity="0.9"/><circle cx="212" cy="44" r="2.2" fill="#fff" opacity="0.85"/><circle cx="195" cy="96" r="1.5" fill="#FDE047" opacity="0.8"/><circle cx="52" cy="186" r="1.8" fill="#fff" opacity="0.7"/><circle cx="176" cy="176" r="46" fill="url(#st-pl)"/><ellipse cx="176" cy="176" rx="68" ry="14" transform="rotate(-18 176 176)" fill="none" stroke="#FDBA74" stroke-width="5" opacity="0.75"/><g transform="translate(88 104) rotate(-25)"><path d="M0 -34 L20 22 L0 12 L-20 22 Z" fill="#F8FAFC"/><path d="M0 -24 L9 8 L0 4 L-9 8 Z" fill="#38BDF8"/><path d="M-8 16 L0 34 L8 16 Z" fill="#F97316"/></g><rect y="198" width="256" height="58" fill="rgba(4,9,24,0.72)"/><text x="18" y="224" fill="#FFFFFF" font-family="sans-serif" font-weight="800" font-size="19">STELLAR</text><text x="18" y="243" fill="#38BDF8" font-family="sans-serif" font-weight="700" font-size="13" letter-spacing="2">ODYSSEY</text></svg>`,
  },
  blocks: {
    w: 256,
    h: 256,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#171923"/><g opacity="0.14" stroke="#94A3B8" stroke-width="1"><line x1="32" y1="0" x2="32" y2="256"/><line x1="64" y1="0" x2="64" y2="256"/><line x1="96" y1="0" x2="96" y2="256"/><line x1="128" y1="0" x2="128" y2="256"/><line x1="160" y1="0" x2="160" y2="256"/><line x1="192" y1="0" x2="192" y2="256"/><line x1="224" y1="0" x2="224" y2="256"/><line x1="0" y1="64" x2="256" y2="64"/><line x1="0" y1="128" x2="256" y2="128"/><line x1="0" y1="192" x2="256" y2="192"/></g><rect x="64" y="54" width="32" height="32" rx="4" fill="#0AB9E6"/><rect x="96" y="54" width="32" height="32" rx="4" fill="#0AB9E6"/><rect x="128" y="54" width="32" height="32" rx="4" fill="#0AB9E6"/><rect x="96" y="86" width="32" height="32" rx="4" fill="#0AB9E6"/><rect x="32" y="134" width="32" height="32" rx="4" fill="#F59E0B"/><rect x="64" y="134" width="32" height="32" rx="4" fill="#F59E0B"/><rect x="64" y="166" width="32" height="32" rx="4" fill="#F59E0B"/><rect x="96" y="166" width="32" height="32" rx="4" fill="#F59E0B"/><rect x="160" y="102" width="32" height="32" rx="4" fill="#EF4444"/><rect x="160" y="134" width="32" height="32" rx="4" fill="#EF4444"/><rect x="192" y="134" width="32" height="32" rx="4" fill="#EF4444"/><rect x="192" y="166" width="32" height="32" rx="4" fill="#EF4444"/><rect y="204" width="256" height="52" fill="rgba(15,23,42,0.9)"/><text x="18" y="236" fill="#FFFFFF" font-family="sans-serif" font-weight="800" font-size="20">BLOCK STACK DX</text></svg>`,
  },
  chromatic: {
    w: 256,
    h: 256,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="ch-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1E1B4B"/><stop offset="100%" stop-color="#0F172A"/></linearGradient></defs><rect width="256" height="256" fill="url(#ch-bg)"/><circle cx="128" cy="112" r="70" fill="none" stroke="#F43F5E" stroke-width="10"/><circle cx="128" cy="112" r="50" fill="none" stroke="#F59E0B" stroke-width="10"/><circle cx="128" cy="112" r="30" fill="none" stroke="#10B981" stroke-width="10"/><circle cx="128" cy="112" r="12" fill="#38BDF8"/><rect y="200" width="256" height="56" fill="rgba(15,23,42,0.85)"/><text x="18" y="225" fill="#FFFFFF" font-family="sans-serif" font-weight="800" font-size="18">CHROMATIC</text><text x="18" y="243" fill="#34D399" font-family="sans-serif" font-weight="700" font-size="12" letter-spacing="2">DRIFT</text></svg>`,
  },
  hex: {
    w: 256,
    h: 256,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#0D1117"/><rect x="20" y="24" width="216" height="156" rx="8" fill="#161B22" stroke="#30363D" stroke-width="2"/><text x="34" y="52" fill="#58A6FF" font-family="monospace" font-weight="700" font-size="13">GPT: NX_EMMC_32G</text><text x="34" y="76" fill="#8B949E" font-family="monospace" font-size="11">0000: 4E 58 46 53 02 00</text><text x="34" y="96" fill="#3FB950" font-family="monospace" font-size="11">BOOT0  [CRC32 OK]</text><text x="34" y="116" fill="#3FB950" font-family="monospace" font-size="11">BOOT1  [PK21  OK]</text><text x="34" y="136" fill="#F0883E" font-family="monospace" font-size="11">SYSTEM [IDB 16KB]</text><text x="34" y="156" fill="#A5D6FF" font-family="monospace" font-size="11">USER   [MOUNTED ]</text><text x="18" y="218" fill="#F0F6FC" font-family="sans-serif" font-weight="800" font-size="17">NAND HEX</text><text x="18" y="238" fill="#58A6FF" font-family="sans-serif" font-weight="600" font-size="12">PARTITION INSPECTOR</text></svg>`,
  },
  sketch: {
    w: 256,
    h: 256,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#F8FAFC"/><rect x="22" y="22" width="212" height="162" rx="10" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="2"/><path d="M48 136 C78 60, 128 164, 168 84 C182 56, 204 106, 208 122" fill="none" stroke="#E60012" stroke-width="10" stroke-linecap="round"/><circle cx="88" cy="76" r="14" fill="#0AB9E6"/><rect x="148" y="116" width="32" height="32" rx="6" fill="#F59E0B"/><rect y="198" width="256" height="58" fill="#1E293B"/><text x="18" y="224" fill="#FFFFFF" font-family="sans-serif" font-weight="800" font-size="17">TACTILE</text><text x="18" y="242" fill="#38BDF8" font-family="sans-serif" font-weight="700" font-size="12">SKETCHPAD</text></svg>`,
  },
  cartridge: {
    w: 256,
    h: 256,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#23272F"/><rect x="66" y="28" width="124" height="148" rx="10" fill="#181A20" stroke="#475569" stroke-width="3"/><rect x="78" y="42" width="100" height="82" rx="5" fill="#E60012"/><text x="128" y="88" fill="#FFFFFF" font-family="sans-serif" font-weight="800" font-size="16" text-anchor="middle">NX CARD</text><path d="M96 146 H160" stroke="#F59E0B" stroke-width="6" stroke-linecap="round"/><rect y="198" width="256" height="58" fill="#111317"/><text x="18" y="224" fill="#FFFFFF" font-family="sans-serif" font-weight="800" font-size="17">GAME CARD</text><text x="18" y="242" fill="#94A3B8" font-family="sans-serif" font-weight="600" font-size="12">VIRTUAL SLOT</text></svg>`,
  },
  trivia: {
    w: 256,
    h: 256,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="tr-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#059669"/><stop offset="100%" stop-color="#0F766E"/></linearGradient></defs><rect width="256" height="256" fill="url(#tr-bg)"/><circle cx="128" cy="100" r="46" fill="rgba(255,255,255,0.16)"/><text x="128" y="114" fill="#FFFFFF" font-family="sans-serif" font-weight="800" font-size="42" text-anchor="middle">?</text><rect y="198" width="256" height="58" fill="rgba(6,78,59,0.85)"/><text x="18" y="224" fill="#FFFFFF" font-family="sans-serif" font-weight="800" font-size="16">ARCHITECTURE QUIZ</text><text x="18" y="242" fill="#A7F3D0" font-family="sans-serif" font-weight="600" font-size="11">NX SOFTWARE</text></svg>`,
  },
};

export function buildArtworkPackBinary(): Uint8Array {
  const keys = Object.keys(FACTORY_ARTWORK_SVGS);
  const w = new BinaryWriter(8192);
  w.writeMagic('ART0');
  w.writeU16(keys.length);
  for (const id of keys) {
    const item = FACTORY_ARTWORK_SVGS[id];
    const svgBytes = encoder.encode(item.svg);
    w.writeFixedString(id, 16);
    w.writeU16(item.w);
    w.writeU16(item.h);
    w.writeU32(svgBytes.length);
    w.writeBytes(svgBytes);
  }
  return w.finishWithCrc32();
}

export function decodeArtworkPack(bytes: Uint8Array): Record<string, string> {
  verifyTrailingCrc32(bytes, 'SYSTEM ART0');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'ART0') throw new Error('Invalid ART0 magic');
  const count = r.readU16();
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const id = r.readFixedString(16);
    r.readU16(); // w
    r.readU16(); // h
    const len = r.readU32();
    const raw = r.readBytes(len);
    out[id] = svgBytesToDataUrl(raw);
  }
  return out;
}

// ============================================================================
// 2. GLY0: Avatar Icon Vectors (/sys/assets/avatar_glyphs.bin)
// ============================================================================
const FACTORY_AVATAR_GLYPHS: Record<string, string> = {
  star: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M16 4l3.5 7.2 7.9 1.1-5.7 5.6 1.3 7.9-7-3.7-7 3.7 1.3-7.9-5.7-5.6 7.9-1.1z" fill="#FFFFFF"/></svg>`,
  gamepad: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="4" y="9" width="24" height="14" rx="5" fill="#FFFFFF"/><circle cx="11" cy="16" r="2.2" fill="#1E293B"/><circle cx="21" cy="14" r="1.5" fill="#E60012"/><circle cx="23" cy="17" r="1.5" fill="#0AB9E6"/></svg>`,
  flame: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M16 3c2 5-3 7 0 12 2-3 5-2 5 2a7 7 0 1 1-14 0c0-5 5-9 9-14z" fill="#FFFFFF"/></svg>`,
  leaf: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M25 6C14 6 7 12 7 23c10 0 18-6 18-17z" fill="#FFFFFF"/><path d="M7 25L18 14" stroke="#0F172A" stroke-width="2" stroke-linecap="round"/></svg>`,
};

export function buildAvatarGlyphsBinary(): Uint8Array {
  const keys = Object.keys(FACTORY_AVATAR_GLYPHS);
  const w = new BinaryWriter(1024);
  w.writeMagic('GLY0');
  w.writeU16(keys.length);
  for (const id of keys) {
    const svgBytes = encoder.encode(FACTORY_AVATAR_GLYPHS[id]);
    w.writeFixedString(id, 16);
    w.writeU32(svgBytes.length);
    w.writeBytes(svgBytes);
  }
  return w.finishWithCrc32();
}

export function decodeAvatarGlyphs(bytes: Uint8Array): Record<string, string> {
  verifyTrailingCrc32(bytes, 'SYSTEM GLY0');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'GLY0') throw new Error('Invalid GLY0 magic');
  const count = r.readU16();
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const id = r.readFixedString(16);
    const len = r.readU32();
    out[id] = svgBytesToDataUrl(r.readBytes(len));
  }
  return out;
}

// ============================================================================
// 3. SPL0: Boot Splash Image (/sys/assets/boot_splash.bin)
// ============================================================================
export const FACTORY_BOOT_SPLASH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect x="16" y="14" width="36" height="92" rx="14" fill="none" stroke="#FFFFFF" stroke-width="8"/><circle cx="34" cy="42" r="7" fill="#FFFFFF"/><path d="M66 14h18a16 16 0 0 1 16 16v60a16 16 0 0 1-16 16H66V14z" fill="#FFFFFF"/><circle cx="83" cy="68" r="7.5" fill="#E60012"/></svg>`;

export function buildBootSplashBinary(): Uint8Array {
  const w = new BinaryWriter(512);
  const svgBytes = encoder.encode(FACTORY_BOOT_SPLASH_SVG);
  w.writeMagic('SPL0');
  w.writeFixedString('HORIZON NX', 32);
  w.writeRgbHex('#E60012');
  w.writeRgbHex('#FFFFFF');
  w.writeU32(svgBytes.length);
  w.writeBytes(svgBytes);
  return w.finishWithCrc32();
}

export function decodeBootSplash(bytes: Uint8Array): BootSplashAsset {
  verifyTrailingCrc32(bytes, 'SYSTEM SPL0');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'SPL0') throw new Error('Invalid SPL0 magic');
  const caption = r.readFixedString(32);
  const bgColor = r.readRgbHex();
  const accentColor = r.readRgbHex();
  const len = r.readU32();
  const svgBytes = r.readBytes(len);
  return {
    caption,
    bgColor,
    accentColor,
    dataUrl: svgBytesToDataUrl(svgBytes),
  };
}

// ============================================================================
// 4. SPR0: Raw RGBA8888 Pixel Sprite Atlas (/sys/assets/ui_sprites.bin)
// ============================================================================
const SPRITE_PALETTE: Record<string, [number, number, number, number]> = {
  '.': [0, 0, 0, 0],
  W: [248, 250, 252, 255], // White hull
  C: [56, 189, 248, 255],  // Cyan cockpit / accent
  B: [14, 165, 233, 255],  // Deep cyan wing
  O: [249, 115, 22, 255],  // Orange thruster
  Y: [253, 224, 71, 255],  // Yellow flame core
  R: [225, 29, 72, 255],   // Crimson asteroid shell
  P: [253, 164, 175, 255], // Pink highlight
  D: [136, 19, 55, 255],   // Dark crater
  S: [148, 163, 184, 255], // Silver
  E: [230, 0, 18, 255],   // Switch Red
};

const SPRITE_DEFS: Record<string, string[]> = {
  ship: [
    '.......WW.......',
    '.......WW.......',
    '......WWWW......',
    '......WCCW......',
    '.....WWCCWW.....',
    '.....WWCCWW.....',
    '....WWWCCWWW....',
    '...BWWWWWWWWB...',
    '..BBWWWWWWWWBB..',
    '.BBBWWCCCCWWBBB.',
    'BBBBWWWWWWWWBBBB',
    'BB..WWWWWWWW..BB',
    '....WW.OO.WW....',
    '.......OO.......',
    '......OYYO......',
    '.......YY.......',
  ],
  asteroid: [
    '....RRRRRRRR....',
    '..RRRPPPRRRRRR..',
    '.RRPPPRRRRRDRRR.',
    '.RRPRRRRRRDDDRR.',
    'RRRRRDRRRRRDRRRR',
    'RRRRDDDRRRRRRRRR',
    'RRRRRRRRRRRRDDRR',
    'RRRRRRRRDRRRDRRR',
    'RRRDRRRDDDRRRRRR',
    'RRDDDRRRRRRRRRRR',
    'RRRRRRRRDRRRRRRR',
    '.RRRRRRDDDRRRRR.',
    '.RRRRRRRRRRRRRR.',
    '..RRRRDRRRRRRR..',
    '....RRRRRRRR....',
    '................',
  ],
  nx_badge: [
    '..EEEE....WWWW..',
    '.EEEEEE...WWWWW.',
    '.EE..EE...WWWWW.',
    '.EE..EE...WWWWW.',
    '.EEWWEE...WWWWW.',
    '.EEWWEE...WWWWW.',
    '.EE..EE...WWWWW.',
    '.EE..EE...WWEEW.',
    '.EE..EE...WWEEW.',
    '.EE..EE...WWWWW.',
    '.EE..EE...WWWWW.',
    '.EE..EE...WWWWW.',
    '.EE..EE...WWWWW.',
    '.EE..EE...WWWWW.',
    '.EEEEEE...WWWWW.',
    '..EEEE....WWWW..',
  ],
};

function rasterizePixelGrid(grid: string[]): { width: number; height: number; rgba: Uint8Array } {
  const height = grid.length;
  const width = grid[0].length;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = grid[y];
    for (let x = 0; x < width; x++) {
      const ch = row[x] ?? '.';
      const color = SPRITE_PALETTE[ch] ?? SPRITE_PALETTE['.'];
      const idx = (y * width + x) * 4;
      rgba[idx] = color[0];
      rgba[idx + 1] = color[1];
      rgba[idx + 2] = color[2];
      rgba[idx + 3] = color[3];
    }
  }
  return { width, height, rgba };
}

export function buildSpriteAtlasBinary(): Uint8Array {
  const ids = Object.keys(SPRITE_DEFS);
  const w = new BinaryWriter(4096);
  w.writeMagic('SPR0');
  w.writeU16(ids.length);
  for (const id of ids) {
    const bmp = rasterizePixelGrid(SPRITE_DEFS[id]);
    w.writeFixedString(id, 16);
    w.writeU16(bmp.width);
    w.writeU16(bmp.height);
    w.writeU32(bmp.rgba.length);
    w.writeBytes(bmp.rgba);
  }
  return w.finishWithCrc32();
}

export function decodeSpriteAtlas(bytes: Uint8Array): Record<string, SpriteBitmap> {
  verifyTrailingCrc32(bytes, 'SYSTEM SPR0');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'SPR0') throw new Error('Invalid SPR0 magic');
  const count = r.readU16();
  const out: Record<string, SpriteBitmap> = {};
  for (let i = 0; i < count; i++) {
    const id = r.readFixedString(16);
    const width = r.readU16();
    const height = r.readU16();
    const byteLen = r.readU32();
    const rgba = r.readBytes(byteLen);
    if (rgba.length !== width * height * 4) {
      throw new Error(`Sprite ${id} RGBA buffer length mismatch`);
    }
    out[id] = { id, width, height, rgba };
  }
  return out;
}

// ============================================================================
// 5. SEQ0: Boot Audio Note Sequence (/sys/sound/boot_chime.bin)
// ============================================================================
const WAVE_LIST: BootChimeNote['wave'][] = ['sine', 'triangle', 'square'];

export const FACTORY_BOOT_CHIME: BootChimeNote[] = [
  { freqHz: 523.25, startMs: 0, durationMs: 110, wave: 'triangle', gain: 0.06 },   // C5
  { freqHz: 659.25, startMs: 85, durationMs: 120, wave: 'triangle', gain: 0.07 },  // E5
  { freqHz: 783.99, startMs: 170, durationMs: 150, wave: 'sine', gain: 0.08 },     // G5
  { freqHz: 1046.5, startMs: 255, durationMs: 260, wave: 'sine', gain: 0.09 },     // C6
];

export function buildBootChimeBinary(notes: BootChimeNote[] = FACTORY_BOOT_CHIME): Uint8Array {
  const w = new BinaryWriter(128);
  w.writeMagic('SEQ0');
  w.writeU16(notes.length);
  for (const n of notes) {
    w.writeU16(Math.round(n.freqHz));
    w.writeU16(n.startMs);
    w.writeU16(n.durationMs);
    w.writeU8(Math.max(0, WAVE_LIST.indexOf(n.wave)));
    w.writeU8(Math.round(n.gain * 1000));
  }
  return w.finishWithCrc32();
}

export function decodeBootChime(bytes: Uint8Array): BootChimeNote[] {
  verifyTrailingCrc32(bytes, 'SYSTEM SEQ0');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'SEQ0') throw new Error('Invalid SEQ0 magic');
  const count = r.readU16();
  const out: BootChimeNote[] = [];
  for (let i = 0; i < count; i++) {
    const freqHz = r.readU16();
    const startMs = r.readU16();
    const durationMs = r.readU16();
    const waveIdx = r.readU8();
    const gainMilli = r.readU8();
    out.push({
      freqHz,
      startMs,
      durationMs,
      wave: WAVE_LIST[waveIdx] ?? 'sine',
      gain: gainMilli / 1000,
    });
  }
  return out;
}

// ============================================================================
// 6. STLR / TET0 / CHR0 / QUZ0: Game Code & Level Assets
// ============================================================================
export const FACTORY_STELLAR_CONFIG: StellarGameConfig = {
  shipSpeed: 5.4,
  bulletSpeed: 8.0,
  fireIntervalTicks: 15,
  spawnIntervalTicks: 22,
  pointsPerRock: 100,
  bgColor: '#070B16',
  bulletColor: '#38BDF8',
};

export function buildStellarDataBinary(cfg: StellarGameConfig = FACTORY_STELLAR_CONFIG): Uint8Array {
  const w = new BinaryWriter(128);
  w.writeMagic('STLR');
  w.writeF32(cfg.shipSpeed);
  w.writeF32(cfg.bulletSpeed);
  w.writeU16(cfg.fireIntervalTicks);
  w.writeU16(cfg.spawnIntervalTicks);
  w.writeU32(cfg.pointsPerRock);
  w.writeRgbHex(cfg.bgColor);
  w.writeRgbHex(cfg.bulletColor);
  return w.finishWithCrc32();
}

export function decodeStellarData(bytes: Uint8Array): StellarGameConfig {
  verifyTrailingCrc32(bytes, 'SYSTEM STLR');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'STLR') throw new Error('Invalid STLR magic');
  return {
    shipSpeed: r.readF32(),
    bulletSpeed: r.readF32(),
    fireIntervalTicks: r.readU16(),
    spawnIntervalTicks: r.readU16(),
    pointsPerRock: r.readU32(),
    bgColor: r.readRgbHex(),
    bulletColor: r.readRgbHex(),
  };
}

export const FACTORY_TETROMINO_CONFIG: TetrominoGameConfig = {
  dropIntervalMs: 460,
  lockBonus: 25,
  lineScore: 150,
  shapes: [
    { name: 'I-Beam', color: '#0AB9E6', cells: [[1, 1, 1, 1]] },
    { name: 'O-Cube', color: '#F59E0B', cells: [[1, 1], [1, 1]] },
    { name: 'T-Node', color: '#E11D48', cells: [[0, 1, 0], [1, 1, 1]] },
    { name: 'L-Hook', color: '#10B981', cells: [[1, 0], [1, 0], [1, 1]] },
    { name: 'Z-Step', color: '#A855F7', cells: [[1, 1, 0], [0, 1, 1]] },
  ],
};

export function buildTetrominoDataBinary(
  cfg: TetrominoGameConfig = FACTORY_TETROMINO_CONFIG
): Uint8Array {
  const w = new BinaryWriter(256);
  w.writeMagic('TET0');
  w.writeU16(cfg.dropIntervalMs);
  w.writeU16(cfg.lockBonus);
  w.writeU16(cfg.lineScore);
  w.writeU8(cfg.shapes.length);
  for (const s of cfg.shapes) {
    w.writeFixedString(s.name, 12);
    w.writeRgbHex(s.color);
    const rows = s.cells.length;
    const cols = s.cells[0]?.length ?? 0;
    w.writeU8(rows);
    w.writeU8(cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        w.writeU8(s.cells[r][c] ? 1 : 0);
      }
    }
  }
  return w.finishWithCrc32();
}

export function decodeTetrominoData(bytes: Uint8Array): TetrominoGameConfig {
  verifyTrailingCrc32(bytes, 'SYSTEM TET0');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'TET0') throw new Error('Invalid TET0 magic');
  const dropIntervalMs = r.readU16();
  const lockBonus = r.readU16();
  const lineScore = r.readU16();
  const count = r.readU8();
  const shapes: TetrominoDef[] = [];
  for (let i = 0; i < count; i++) {
    const name = r.readFixedString(12);
    const color = r.readRgbHex();
    const rows = r.readU8();
    const cols = r.readU8();
    const cells: number[][] = [];
    for (let row = 0; row < rows; row++) {
      const line: number[] = [];
      for (let col = 0; col < cols; col++) {
        line.push(r.readU8());
      }
      cells.push(line);
    }
    shapes.push({ name, color, cells });
  }
  return { dropIntervalMs, lockBonus, lineScore, shapes };
}

export const FACTORY_CHROMATIC_PADS: ChromaticPadDef[] = [
  { id: 0, label: 'Red', color: '#E60012', freqHz: 330, durationMs: 140 },
  { id: 1, label: 'Cyan', color: '#0AB9E6', freqHz: 440, durationMs: 140 },
  { id: 2, label: 'Amber', color: '#F59E0B', freqHz: 554, durationMs: 140 },
  { id: 3, label: 'Emerald', color: '#10B981', freqHz: 659, durationMs: 140 },
];

export function buildChromaticDataBinary(
  pads: ChromaticPadDef[] = FACTORY_CHROMATIC_PADS
): Uint8Array {
  const w = new BinaryWriter(128);
  w.writeMagic('CHR0');
  w.writeU8(pads.length);
  for (const p of pads) {
    w.writeU8(p.id);
    w.writeFixedString(p.label, 16);
    w.writeRgbHex(p.color);
    w.writeU16(p.freqHz);
    w.writeU16(p.durationMs);
  }
  return w.finishWithCrc32();
}

export function decodeChromaticData(bytes: Uint8Array): ChromaticPadDef[] {
  verifyTrailingCrc32(bytes, 'SYSTEM CHR0');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'CHR0') throw new Error('Invalid CHR0 magic');
  const count = r.readU8();
  const out: ChromaticPadDef[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: r.readU8(),
      label: r.readFixedString(16),
      color: r.readRgbHex(),
      freqHz: r.readU16(),
      durationMs: r.readU16(),
    });
  }
  return out;
}

export const FACTORY_QUIZ_PACKAGE: QuizPackage = {
  titleId: 'title-trivia',
  title: 'Console Architecture Quiz',
  version: '1.2.0',
  pointsPerCorrect: 250,
  questions: [
    {
      q: 'Which partition holds the BCT0 DRAM table and Stage 1 Bootloader?',
      opts: ['BOOT0', 'SAFE', 'USER', 'PRODINFOF'],
      ans: 0,
    },
    {
      q: 'What binary package magic does Stage 2 Bootloader verify inside BOOT1?',
      opts: ['NXFS', 'PK21', 'ELF0', 'MBR2'],
      ans: 1,
    },
    {
      q: 'Which partition stores console serial, MAC address, and fuse calibration?',
      opts: ['SYSTEM', 'BCPKG2', 'PRODINFO', 'BOOT1'],
      ans: 2,
    },
    {
      q: 'Where are themes, artwork packs, NXVM code, and UI SFX tables stored?',
      opts: ['SYSTEM', 'PRODINFO', 'BOOT0', 'SAFE'],
      ans: 0,
    },
    {
      q: 'Which executable container format holds Horizon userland AArch64 programs?',
      opts: ['NRO0', 'JPEG', 'ZIP2', 'BMP1'],
      ans: 0,
    },
  ],
};

export function buildQuizPackageBinary(pkg: QuizPackage = FACTORY_QUIZ_PACKAGE): Uint8Array {
  const w = new BinaryWriter(1024);
  w.writeMagic('QUZ0');
  w.writeFixedString(pkg.titleId, 20);
  w.writeFixedString(pkg.title, 36);
  w.writeFixedString(pkg.version, 12);
  w.writeU16(pkg.pointsPerCorrect);
  w.writeU16(pkg.questions.length);
  for (const q of pkg.questions) {
    w.writeVarString(q.q);
    w.writeU8(q.ans);
    w.writeU8(q.opts.length);
    for (const opt of q.opts) {
      w.writeVarString(opt);
    }
  }
  return w.finishWithCrc32();
}

export function decodeQuizPackage(bytes: Uint8Array): QuizPackage {
  verifyTrailingCrc32(bytes, 'NXFS QUZ0');
  const r = new BinaryReader(bytes);
  if (r.readMagic(4) !== 'QUZ0') throw new Error('Invalid QUZ0 magic');
  const titleId = r.readFixedString(20);
  const title = r.readFixedString(36);
  const version = r.readFixedString(12);
  const pointsPerCorrect = r.readU16();
  const qCount = r.readU16();
  const questions: QuizQuestion[] = [];
  for (let i = 0; i < qCount; i++) {
    const q = r.readVarString();
    const ans = r.readU8();
    const optCount = r.readU8();
    const opts: string[] = [];
    for (let j = 0; j < optCount; j++) {
      opts.push(r.readVarString());
    }
    questions.push({ q, opts, ans });
  }
  return { titleId, title, version, pointsPerCorrect, questions };
}

// ============================================================================
// 7. NRO0: AArch64 Userland Executable Binary (/sys/code/qlaunch.nro)
// ============================================================================
export function buildQlaunchNroBinary(): Uint8Array {
  // Real AArch64 initialization & IPC message-loop machine code
  const arm64Opcodes = [
    0xa9bf7bfd, // stp x29, x30, [sp, #-16]!
    0x910003fd, // mov x29, sp
    0xd2800020, // mov x0, #1
    0xd4000421, // svc #0x21 (svcSendSyncRequest to sm:)
    0x94000008, // bl qlaunch_mount_themes
    0x94000010, // bl qlaunch_render_home_grid
    0xd2800000, // mov x0, #0
    0xa8c17bfd, // ldp x29, x30, [sp], #16
    0xd65f03c0, // ret
  ];
  const symbols = [
    '_start',
    'qlaunch_mount_themes',
    'qlaunch_load_art0',
    'qlaunch_exec_nxvm_battery',
    'qlaunch_render_home_grid',
    'svcSendSyncRequest',
  ];

  const textBuf = new Uint8Array(arm64Opcodes.length * 4);
  const textView = new DataView(textBuf.buffer);
  arm64Opcodes.forEach((op, idx) => textView.setUint32(idx * 4, op, true));
  const textCrc32 = crc32(textBuf);

  const rodataStr = symbols.join('\0') + '\0';
  const rodataBytes = encoder.encode(rodataStr);
  const dataBytes = encoder.encode('QLAUNCH_HOME_MENU_18.1.0\0NXFS_V2\0ART0_SPR0_NXVM\0');

  const w = new BinaryWriter(512);
  w.writeMagic('NRO0');
  w.writeFixedString('0100000000001000', 20);
  w.writeFixedString('qlaunch', 16);
  w.writeU32(0x00000080); // entry offset / virtual base
  w.writeU32(textBuf.length);
  w.writeU32(rodataBytes.length);
  w.writeU32(dataBytes.length);
  w.writeU32(textCrc32);
  w.writeBytes(textBuf);
  w.writeBytes(rodataBytes);
  w.writeBytes(dataBytes);
  return w.finishWithCrc32();
}

export function decodeQlaunchNro(bytes: Uint8Array): NroProgramHeader {
  verifyTrailingCrc32(bytes, 'SYSTEM NRO0');
  const r = new BinaryReader(bytes);
  const magic = r.readMagic(4);
  if (magic !== 'NRO0') throw new Error(`Invalid NRO0 magic "${magic}"`);
  const titleId = r.readFixedString(20);
  const name = r.readFixedString(16);
  const entryAddr = r.readU32();
  const textSize = r.readU32();
  const rodataSize = r.readU32();
  const dataSize = r.readU32();
  const textCrc32 = r.readU32();

  const textBuf = r.readBytes(textSize);
  if (crc32(textBuf) !== textCrc32) {
    throw new Error('NRO0 .text executable section CRC32 mismatch');
  }
  const textView = new DataView(textBuf.buffer, textBuf.byteOffset, textBuf.byteLength);
  const arm64Opcodes: number[] = [];
  for (let i = 0; i + 4 <= textBuf.length; i += 4) {
    arm64Opcodes.push(textView.getUint32(i, true));
  }

  const rodataBuf = r.readBytes(rodataSize);
  const symbols = decoder
    .decode(rodataBuf)
    .split('\0')
    .filter((s) => s.length > 0);
  r.readBytes(dataSize); // consume .data section

  return {
    magic: 'NRO0',
    titleId,
    name,
    entryAddr,
    textSize,
    rodataSize,
    dataSize,
    textCrc32,
    arm64Opcodes,
    symbols,
  };
}
