import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  Cpu,
  Download,
  HardDrive,
  Monitor,
  Palette,
  Plane,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  User,
  Volume2,
} from 'lucide-react';
import { switchAudio } from '../../audio/switchAudio';
import { formatHex32 } from '../../nand/crc32';
import {
  downloadFullNandBin,
  restoreFullNandFromFile,
} from '../../nand/nandBackupUtils';
import { nandStore } from '../../nand/nandChunkStore';
import {
  BootedSystemContext,
  ConsoleSettings,
  InstalledTitle,
  NandPartitionMeta,
  SwitchThemeTokens,
  UserProfile,
} from '../../nand/nandTypes';

interface SettingsAppletProps {
  system: BootedSystemContext;
  theme: SwitchThemeTokens;
  onUpdateSettings: (patch: Partial<ConsoleSettings>) => Promise<void>;
  onUpdateProfiles: (profiles: UserProfile[]) => Promise<void>;
  onDeleteTitle: (titleId: string) => Promise<void>;
  onReboot: (mode: 'NORMAL' | 'MAINTENANCE') => void;
  onFactoryReset: () => Promise<void>;
  onClose: () => void;
}

type SettingsTab =
  | 'overview'
  | 'airplane'
  | 'display'
  | 'themes'
  | 'data'
  | 'users'
  | 'system';

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Console & Boot Summary', icon: <Cpu className="w-4 h-4" /> },
  { id: 'airplane', label: 'Airplane Mode & Wi-Fi', icon: <Plane className="w-4 h-4" /> },
  { id: 'display', label: 'Screen & Audio', icon: <Monitor className="w-4 h-4" /> },
  { id: 'themes', label: 'Themes', icon: <Palette className="w-4 h-4" /> },
  { id: 'data', label: 'Data Management (NAND)', icon: <HardDrive className="w-4 h-4" /> },
  { id: 'users', label: 'Users', icon: <User className="w-4 h-4" /> },
  { id: 'system', label: 'System & Bootloader', icon: <ShieldCheck className="w-4 h-4" /> },
];

export const SettingsApplet: React.FC<SettingsAppletProps> = ({
  system,
  theme,
  onUpdateSettings,
  onUpdateProfiles,
  onDeleteTitle,
  onReboot,
  onFactoryReset,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('themes');
  const [partitions, setPartitions] = useState<NandPartitionMeta[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [nandBackupMsg, setNandBackupMsg] = useState<string | null>(null);
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  const activeUser =
    system.profiles.find((p) => p.id === system.settings.activeUserId) ??
    system.profiles[0];

  const [editName, setEditName] = useState(activeUser?.name ?? 'Player');

  useEffect(() => {
    setEditName(activeUser?.name ?? 'Player');
  }, [activeUser?.id, activeUser?.name]);

  useEffect(() => {
    nandStore.listPartitions().then(setPartitions);
  }, [system.titles]);

  const isDark = theme.id === 'dark';

  const handleSaveName = async () => {
    const trimmed = editName.trim();
    if (!trimmed || !activeUser) return;
    switchAudio.play('select');
    const updated = system.profiles.map((p) =>
      p.id === activeUser.id ? { ...p, name: trimmed } : p
    );
    await onUpdateProfiles(updated);
  };

  const handleCycleAvatarColor = async (color: string) => {
    if (!activeUser) return;
    switchAudio.play('tick');
    const updated = system.profiles.map((p) =>
      p.id === activeUser.id ? { ...p, avatarBg: color } : p
    );
    await onUpdateProfiles(updated);
  };

  const handleSelectAvatarGlyph = async (glyph: UserProfile['avatarGlyph']) => {
    if (!activeUser) return;
    switchAudio.play('tick');
    const updated = system.profiles.map((p) =>
      p.id === activeUser.id ? { ...p, avatarGlyph: glyph } : p
    );
    await onUpdateProfiles(updated);
  };

  return (
    <div
      className="w-full h-full flex flex-col select-none"
      style={{ backgroundColor: theme.bgCanvas, color: theme.textPrimary }}
    >
      {/* Top Bar */}
      <div
        className="flex items-center justify-between px-7 py-3.5 border-b shrink-0"
        style={{ borderColor: theme.borderHairline }}
      >
        <div className="flex items-center gap-3">
          <div className="w-1.5 h-6 rounded-full bg-[#0AB9E6]" />
          <h1 className="font-display font-bold text-lg">System Settings</h1>
        </div>
        <button
          onClick={() => {
            switchAudio.play('back');
            onClose();
          }}
          className="px-3.5 py-1.5 rounded-md text-xs font-semibold border transition-colors cursor-pointer"
          style={{
            borderColor: theme.borderHairline,
            backgroundColor: theme.bgTile,
            color: theme.textPrimary,
          }}
        >
          B · Back to HOME
        </button>
      </div>

      {/* Two-Column Switch Settings Body */}
      <div className="flex-1 grid grid-cols-12 min-h-0">
        {/* Left Navigation Sidebar */}
        <nav
          className="col-span-4 border-r p-4 space-y-1 overflow-y-auto thin-scrollbar"
          style={{ borderColor: theme.borderHairline }}
        >
          {TABS.map((t) => {
            const active = t.id === activeTab;
            return (
              <button
                key={t.id}
                onClick={() => {
                  switchAudio.play('tick');
                  setActiveTab(t.id);
                }}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-md text-left text-sm font-medium transition-colors cursor-pointer ${
                  active ? 'nx-focus-ring font-semibold' : 'hover:opacity-80'
                }`}
                style={{
                  backgroundColor: active ? theme.bgTile : 'transparent',
                  color: active ? '#0AB9E6' : theme.textPrimary,
                }}
              >
                <span className="flex items-center gap-2.5 truncate">
                  {t.icon}
                  <span className="truncate">{t.label}</span>
                </span>
                {active && <ChevronRight className="w-4 h-4 shrink-0" />}
              </button>
            );
          })}
        </nav>

        {/* Right Detail Pane */}
        <div className="col-span-8 p-6 overflow-y-auto thin-scrollbar">
          {activeTab === 'overview' && (
            <div className="space-y-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="font-display text-base font-bold">
                    Boot Verification, Executable Code &amp; Hardware Calibration
                  </h2>
                  <p className="text-xs mt-1" style={{ color: theme.textSecondary }}>
                    Hydrated directly from IndexedDB GPT partitions during Stage 1 and Stage 2 boot.
                  </p>
                </div>
                <div
                  className="w-12 h-12 rounded-lg p-1.5 flex items-center justify-center shrink-0 border"
                  style={{
                    backgroundColor: system.bootSplash.bgColor,
                    borderColor: theme.borderHairline,
                  }}
                  title={`SPL0 Splash: ${system.bootSplash.caption}`}
                >
                  <img
                    src={system.bootSplash.dataUrl}
                    alt={system.bootSplash.caption}
                    className="w-full h-full object-contain"
                  />
                </div>
              </div>

              <div
                className="rounded-lg border divide-y text-xs"
                style={{
                  borderColor: theme.borderHairline,
                  backgroundColor: theme.bgTile,
                }}
              >
                {[
                  ['Console Serial (PRODINFO)', system.prodInfo.serial],
                  ['Hardware SKU / Board', `${system.prodInfo.sku} · ${system.prodInfo.boardRevision}`],
                  ['Region / Fuses', `${system.prodInfo.region} · ${system.prodInfo.fuseCount}/19 blown`],
                  ['Firmware (SYSTEM HOSM)', `${system.osManifest.codename} ${system.osManifest.osVersion}`],
                  ['Boot Duration / I/O', `${system.bootDurationMs} ms · ${system.totalChunksRead} chunks (${(system.totalBytesRead / 1024).toFixed(1)} KiB)`],
                  ['KIP1 Modules (BCPKG2)', system.kipsLoaded.join(', ')],
                  [
                    'Userland NRO0 (.text)',
                    `${system.qlaunchNro.name}.nro @ ${formatHex32(system.qlaunchNro.entryAddr)} · ${system.qlaunchNro.textSize}B ARM64 (CRC ${formatHex32(system.qlaunchNro.textCrc32)}) · ${system.qlaunchNro.symbols.length} symbols`,
                  ],
                  [
                    'NXVM Power Policy (.nxb)',
                    `${system.batteryTelemetry.batteryPercent}% (${system.batteryTelemetry.estimatedMinutesLeft}m left · ${system.batteryTelemetry.healthPercent}% health · ${system.batteryTelemetry.instructionsExecuted} VM ops)`,
                  ],
                  [
                    'NAND Binary Assets',
                    `${Object.keys(system.artworkImages).length} ART0 box-art · ${Object.keys(system.spriteAtlas).length} SPR0 RGBA8888 sprites · ${Object.keys(system.avatarGlyphs).length} GLY0 glyphs · ${system.bootChime.length} SEQ0 notes`,
                  ],
                  [
                    'Hardware Calibration (CAL/BAT0)',
                    `${system.hardwareCal.touch.width}×${system.hardwareCal.touch.height} ${system.hardwareCal.touch.maxPoints}-pt touch · ${system.hardwareCal.audio.codec} · ${system.hardwareCal.imu.sensor} · ${system.hardwareCal.battery.model} (${system.hardwareCal.battery.capacityMah}mAh)`,
                  ],
                  [
                    'System Capabilities (CAP0)',
                    `${system.capabilities.length} entries (${system.capabilities.map((c) => c.name).join(', ')})`,
                  ],
                ].map(([k, v]) => (
                  <div
                    key={k}
                    className="flex items-center justify-between gap-4 px-4 py-2.5"
                    style={{ borderColor: theme.borderHairline }}
                  >
                    <span className="shrink-0" style={{ color: theme.textSecondary }}>{k}</span>
                    <span className="font-mono-tabular font-semibold text-right truncate">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'airplane' && (
            <div className="space-y-5">
              <div>
                <h2 className="font-display text-base font-bold">
                  Airplane Mode & Wireless Networking
                </h2>
                <p className="text-xs mt-1" style={{ color: theme.textSecondary }}>
                  Changes persist immediately to /user/save/settings.bin (SET0 binary) inside USER NAND chunks.
                </p>
              </div>

              <div
                className="rounded-lg border p-4 flex items-center justify-between"
                style={{
                  borderColor: theme.borderHairline,
                  backgroundColor: theme.bgTile,
                }}
              >
                <div>
                  <div className="text-sm font-semibold">Airplane Mode</div>
                  <div className="text-xs mt-0.5" style={{ color: theme.textSecondary }}>
                    Disables Wi-Fi radio and network status indicator on HOME Menu
                  </div>
                </div>
                <button
                  onClick={() => {
                    switchAudio.play('select');
                    onUpdateSettings({ airplaneMode: !system.settings.airplaneMode });
                  }}
                  className={`px-4 py-1.5 rounded-md text-xs font-bold cursor-pointer transition-colors ${
                    system.settings.airplaneMode
                      ? 'bg-[#0AB9E6] text-slate-950'
                      : isDark
                        ? 'bg-slate-700 text-slate-200'
                        : 'bg-slate-200 text-slate-800'
                  }`}
                >
                  {system.settings.airplaneMode ? 'On' : 'Off'}
                </button>
              </div>

              <div
                className="rounded-lg border p-4 flex items-center justify-between"
                style={{
                  borderColor: theme.borderHairline,
                  backgroundColor: theme.bgTile,
                }}
              >
                <div>
                  <div className="text-sm font-semibold">Connected Network</div>
                  <div className="text-xs mt-0.5" style={{ color: theme.textSecondary }}>
                    MAC Address (PRODINFO): {system.prodInfo.macAddress}
                  </div>
                </div>
                <span className="text-xs font-mono-tabular font-semibold">
                  {system.settings.airplaneMode ? 'Disconnected' : system.settings.wifiSsid}
                </span>
              </div>
            </div>
          )}

          {activeTab === 'display' && (
            <div className="space-y-5">
              <div>
                <h2 className="font-display text-base font-bold">
                  Screen Brightness & Console Audio
                </h2>
                <p className="text-xs mt-1" style={{ color: theme.textSecondary }}>
                  Audio synthesizer parameters are loaded from /sys/sound/ui_sfx_table.bin (SFX0 binary) on SYSTEM NAND.
                </p>
              </div>

              <div
                className="rounded-lg border p-4 space-y-4"
                style={{
                  borderColor: theme.borderHairline,
                  backgroundColor: theme.bgTile,
                }}
              >
                <div>
                  <div className="flex justify-between text-xs font-medium mb-2">
                    <span>LCD Brightness ({system.prodInfo.lcdProfile})</span>
                    <span className="font-mono-tabular">{system.settings.brightness}%</span>
                  </div>
                  <input
                    type="range"
                    min={30}
                    max={100}
                    value={system.settings.brightness}
                    onChange={(e) =>
                      onUpdateSettings({ brightness: Number(e.target.value) })
                    }
                    className="w-full accent-[#0AB9E6] cursor-pointer"
                  />
                </div>

                <div className="pt-2 border-t" style={{ borderColor: theme.borderHairline }}>
                  <div className="flex justify-between text-xs font-medium mb-2">
                    <span className="flex items-center gap-1.5">
                      <Volume2 className="w-3.5 h-3.5" />
                      System UI Volume
                    </span>
                    <span className="font-mono-tabular">
                      {system.settings.muted ? 'Muted' : `${system.settings.volume}%`}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={system.settings.volume}
                      onChange={(e) => {
                        onUpdateSettings({ volume: Number(e.target.value), muted: false });
                      }}
                      className="flex-1 accent-[#0AB9E6] cursor-pointer"
                    />
                    <button
                      onClick={() => onUpdateSettings({ muted: !system.settings.muted })}
                      className="px-3 py-1 rounded text-xs font-semibold border cursor-pointer"
                      style={{ borderColor: theme.borderHairline }}
                    >
                      {system.settings.muted ? 'Unmute' : 'Mute'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'themes' && (
            <div className="space-y-5">
              <div>
                <h2 className="font-display text-base font-bold">HOME Menu Themes</h2>
                <p className="text-xs mt-1" style={{ color: theme.textSecondary }}>
                  Theme color tokens are loaded from SYSTEM NAND (/sys/themes/) and preference is written to USER NAND.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {(['light', 'dark'] as const).map((tid) => {
                  const tObj = system.themes[tid];
                  const selected = system.settings.theme === tid;
                  return (
                    <button
                      key={tid}
                      onClick={() => {
                        switchAudio.play('select');
                        onUpdateSettings({ theme: tid });
                      }}
                      className={`p-4 rounded-lg border text-left transition-all cursor-pointer ${
                        selected ? 'nx-focus-ring' : ''
                      }`}
                      style={{
                        backgroundColor: tObj.bgCanvas,
                        color: tObj.textPrimary,
                        borderColor: selected ? '#0AB9E6' : theme.borderHairline,
                      }}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <span className="font-display font-bold text-sm">{tObj.name}</span>
                        {selected && (
                          <span className="w-5 h-5 rounded-full bg-[#0AB9E6] text-white flex items-center justify-center">
                            <Check className="w-3.5 h-3.5" />
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div
                          className="h-10 rounded border"
                          style={{
                            backgroundColor: tObj.bgTile,
                            borderColor: tObj.borderHairline,
                          }}
                        />
                        <div
                          className="h-10 rounded border"
                          style={{
                            backgroundColor: tObj.bgTile,
                            borderColor: tObj.borderHairline,
                          }}
                        />
                        <div
                          className="h-10 rounded border"
                          style={{
                            backgroundColor: tObj.bgTileEmpty,
                            borderColor: tObj.borderHairline,
                          }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'data' && (
            <div className="space-y-5">
              <div>
                <h2 className="font-display text-base font-bold">
                  eMMC NAND Partitions & Software Data
                </h2>
                <p className="text-xs mt-1" style={{ color: theme.textSecondary }}>
                  Real chunked Uint8Array blocks persisted in browser IndexedDB (nx_nand_emmc_v1).
                </p>
              </div>

              <div
                className="rounded-lg border divide-y text-xs"
                style={{
                  borderColor: theme.borderHairline,
                  backgroundColor: theme.bgTile,
                }}
              >
                {partitions.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between px-4 py-2.5"
                    style={{ borderColor: theme.borderHairline }}
                  >
                    <div>
                      <span className="font-mono-tabular font-bold">{p.id}</span>
                      <span className="ml-2" style={{ color: theme.textSecondary }}>
                        · {p.requiredBy}
                      </span>
                    </div>
                    <div className="font-mono-tabular">
                      {p.chunkCount} chunks · {(p.usedBytes / 1024).toFixed(1)} KiB ·{' '}
                      {formatHex32(p.partitionCrc32)}
                    </div>
                  </div>
                ))}
              </div>

              <div>
                <h3 className="text-xs font-semibold mb-2" style={{ color: theme.textSecondary }}>
                  Installed Software ({system.titles.length})
                </h3>
                <div
                  className="rounded-lg border divide-y text-xs"
                  style={{
                    borderColor: theme.borderHairline,
                    backgroundColor: theme.bgTile,
                  }}
                >
                  {system.titles.map((title: InstalledTitle) => (
                    <div
                      key={title.id}
                      className="flex items-center justify-between px-4 py-2.5"
                      style={{ borderColor: theme.borderHairline }}
                    >
                      <div>
                        <div className="font-semibold">{title.title}</div>
                        <div style={{ color: theme.textSecondary }}>
                          v{title.version} · {title.sizeMb} MB ·{' '}
                          {Math.floor(title.playMinutes / 60)}h {title.playMinutes % 60}m played
                        </div>
                      </div>
                      {system.titles.length > 1 && (
                        <button
                          onClick={() => {
                            switchAudio.play('back');
                            onDeleteTitle(title.id);
                          }}
                          className="p-1.5 rounded hover:bg-red-500/15 text-red-500 cursor-pointer"
                          title="Delete Software from USER NAND"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'users' && activeUser && (
            <div className="space-y-5">
              <div>
                <h2 className="font-display text-base font-bold">User Profile Settings</h2>
                <p className="text-xs mt-1" style={{ color: theme.textSecondary }}>
                  Saved to /user/save/profiles.bin (PRF0 binary) inside USER NAND chunks.
                </p>
              </div>

              <div
                className="rounded-lg border p-4 space-y-4"
                style={{
                  borderColor: theme.borderHairline,
                  backgroundColor: theme.bgTile,
                }}
              >
                <div className="flex items-center gap-4">
                  <div
                    className="w-14 h-14 rounded-full flex items-center justify-center text-white font-display font-bold text-xl shrink-0 overflow-hidden"
                    style={{ backgroundColor: activeUser.avatarBg }}
                  >
                    {system.avatarGlyphs[activeUser.avatarGlyph] ? (
                      <img
                        src={system.avatarGlyphs[activeUser.avatarGlyph]}
                        alt={activeUser.avatarGlyph}
                        className="w-8 h-8 object-contain"
                      />
                    ) : (
                      activeUser.name.slice(0, 1).toUpperCase()
                    )}
                  </div>
                  <div className="flex-1 flex items-center gap-2">
                    <input
                      type="text"
                      value={editName}
                      maxLength={14}
                      onChange={(e) => setEditName(e.target.value)}
                      className="px-3 py-1.5 rounded border text-sm font-medium flex-1 bg-transparent"
                      style={{ borderColor: theme.borderHairline }}
                    />
                    <button
                      onClick={handleSaveName}
                      className="px-4 py-1.5 rounded bg-[#0AB9E6] text-slate-950 text-xs font-bold cursor-pointer"
                    >
                      Save
                    </button>
                  </div>
                </div>

                <div>
                  <div className="text-xs mb-2" style={{ color: theme.textSecondary }}>
                    Icon Background Color &amp; NAND Glyph (/sys/assets/avatar_glyphs.bin)
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      {['#E60012', '#0AB9E6', '#10B981', '#F59E0B', '#6366F1', '#EC4899'].map(
                        (c) => (
                          <button
                            key={c}
                            onClick={() => handleCycleAvatarColor(c)}
                            className={`w-7 h-7 rounded-full cursor-pointer border-2 ${
                              activeUser.avatarBg === c ? 'border-white ring-2 ring-[#0AB9E6]' : 'border-transparent'
                            }`}
                            style={{ backgroundColor: c }}
                            aria-label={`Select color ${c}`}
                          />
                        )
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {(['star', 'gamepad', 'flame', 'leaf'] as const).map((g) => (
                        <button
                          key={g}
                          onClick={() => handleSelectAvatarGlyph(g)}
                          className={`w-9 h-9 rounded-full flex items-center justify-center cursor-pointer border-2 ${
                            activeUser.avatarGlyph === g
                              ? 'border-white ring-2 ring-[#0AB9E6]'
                              : 'border-transparent opacity-75 hover:opacity-100'
                          }`}
                          style={{ backgroundColor: activeUser.avatarBg }}
                          title={`Glyph: ${g}`}
                        >
                          {system.avatarGlyphs[g] ? (
                            <img
                              src={system.avatarGlyphs[g]}
                              alt={g}
                              className="w-5 h-5 object-contain"
                            />
                          ) : (
                            <span className="text-xs text-white font-bold">{g[0]}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'system' && (
            <div className="space-y-5">
              <div>
                <h2 className="font-display text-base font-bold">
                  System Version, Clock & Bootloader Control
                </h2>
                <p className="text-xs mt-1" style={{ color: theme.textSecondary }}>
                  Current System Version: {system.osManifest.osVersion} ({system.osManifest.buildHash})
                </p>
              </div>

              <div
                className="rounded-lg border p-4 flex items-center justify-between"
                style={{
                  borderColor: theme.borderHairline,
                  backgroundColor: theme.bgTile,
                }}
              >
                <div>
                  <div className="text-sm font-semibold">24-Hour Clock</div>
                  <div className="text-xs mt-0.5" style={{ color: theme.textSecondary }}>
                    Toggle status bar clock format between 12h AM/PM and 24h
                  </div>
                </div>
                <button
                  onClick={() => {
                    switchAudio.play('select');
                    onUpdateSettings({ clock24h: !system.settings.clock24h });
                  }}
                  className={`px-4 py-1.5 rounded-md text-xs font-bold cursor-pointer ${
                    system.settings.clock24h
                      ? 'bg-[#0AB9E6] text-slate-950'
                      : isDark
                        ? 'bg-slate-700 text-slate-200'
                        : 'bg-slate-200 text-slate-800'
                  }`}
                >
                  {system.settings.clock24h ? '24-Hour' : '12-Hour'}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={async () => {
                    switchAudio.play('select');
                    try {
                      const res = await downloadFullNandBin(system.prodInfo.serial);
                      setNandBackupMsg(
                        `Exported ${res.partitionCount} partitions (${(res.totalBytes / 1024).toFixed(1)} KiB) to ${res.filename}`
                      );
                    } catch (err) {
                      setNandBackupMsg(
                        err instanceof Error ? err.message : 'Failed to dump NAND .bin'
                      );
                    }
                  }}
                  className="p-3.5 rounded-lg border text-left hover:border-[#0AB9E6] transition-colors cursor-pointer"
                  style={{
                    borderColor: theme.borderHairline,
                    backgroundColor: theme.bgTile,
                  }}
                >
                  <div className="text-xs font-bold flex items-center gap-2">
                    <Download className="w-3.5 h-3.5 text-[#0AB9E6]" />
                    Dump Full NAND (.bin)
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: theme.textSecondary }}>
                    Export all 8 GPT partitions & raw chunks to a single rawnand.bin file
                  </div>
                </button>

                <button
                  onClick={() => {
                    switchAudio.play('modal');
                    restoreInputRef.current?.click();
                  }}
                  className="p-3.5 rounded-lg border text-left hover:border-[#0AB9E6] transition-colors cursor-pointer"
                  style={{
                    borderColor: theme.borderHairline,
                    backgroundColor: theme.bgTile,
                  }}
                >
                  <div className="text-xs font-bold flex items-center gap-2">
                    <Upload className="w-3.5 h-3.5 text-emerald-500" />
                    Restore NAND (.bin)
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: theme.textSecondary }}>
                    Flash a saved NXND .bin image into IndexedDB chunks and reboot
                  </div>
                </button>
              </div>

              <input
                ref={restoreInputRef}
                type="file"
                accept=".bin"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  try {
                    const res = await restoreFullNandFromFile(file);
                    setNandBackupMsg(
                      `Restored ${res.partitionCount} partitions (${(res.totalBytesRestored / 1024).toFixed(1)} KiB). Rebooting...`
                    );
                    setTimeout(() => onReboot('NORMAL'), 700);
                  } catch (err) {
                    switchAudio.play('error');
                    setNandBackupMsg(
                      err instanceof Error ? err.message : 'Invalid NAND .bin backup'
                    );
                  }
                }}
              />

              {nandBackupMsg && (
                <div
                  className="px-3.5 py-2 rounded-md border text-xs font-mono-tabular"
                  style={{
                    borderColor: theme.borderHairline,
                    backgroundColor: theme.bgTile,
                  }}
                >
                  {nandBackupMsg}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => {
                    switchAudio.play('launch');
                    onReboot('NORMAL');
                  }}
                  className="p-3.5 rounded-lg border text-left hover:border-[#0AB9E6] transition-colors cursor-pointer"
                  style={{
                    borderColor: theme.borderHairline,
                    backgroundColor: theme.bgTile,
                  }}
                >
                  <div className="text-xs font-bold flex items-center gap-2">
                    <RefreshCw className="w-3.5 h-3.5 text-[#0AB9E6]" />
                    Cold Reboot (Stage 1 → 2)
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: theme.textSecondary }}>
                    Re-runs full BootROM, NX_BOOT1, and PK21 verification
                  </div>
                </button>

                <button
                  onClick={() => {
                    switchAudio.play('modal');
                    onReboot('MAINTENANCE');
                  }}
                  className="p-3.5 rounded-lg border text-left hover:border-[#0AB9E6] transition-colors cursor-pointer"
                  style={{
                    borderColor: theme.borderHairline,
                    backgroundColor: theme.bgTile,
                  }}
                >
                  <div className="text-xs font-bold flex items-center gap-2">
                    <Cpu className="w-3.5 h-3.5 text-[#0AB9E6]" />
                    Reboot to Bootloader Menu
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: theme.textSecondary }}>
                    Inspect IDB chunks, hex dump partitions, or inject faults
                  </div>
                </button>
              </div>

              <div
                className="rounded-lg border p-4"
                style={{
                  borderColor: 'rgba(239, 68, 68, 0.45)',
                  backgroundColor: theme.bgTile,
                }}
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-red-500">
                      Factory Initialize eMMC NAND
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: theme.textSecondary }}>
                      Re-flashes all 8 IndexedDB partitions back to factory defaults and reboots.
                    </div>
                  </div>
                  {!confirmReset ? (
                    <button
                      onClick={() => setConfirmReset(true)}
                      className="px-3.5 py-1.5 rounded bg-red-600 hover:bg-red-700 text-white text-xs font-semibold cursor-pointer shrink-0"
                    >
                      Initialize Console
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => setConfirmReset(false)}
                        className="px-3 py-1.5 rounded border text-xs cursor-pointer"
                        style={{ borderColor: theme.borderHairline }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={onFactoryReset}
                        className="px-3 py-1.5 rounded bg-red-600 text-white text-xs font-bold cursor-pointer"
                      >
                        Confirm Wipe & Re-Flash
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
