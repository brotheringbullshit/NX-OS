import React, { useState } from 'react';
import {
  CheckCircle2,
  Download,
  Gamepad2,
  Newspaper,
  ShoppingBag,
  Trash2,
  UserCheck,
} from 'lucide-react';
import { switchAudio } from '../../audio/switchAudio';
import {
  AlbumCapture,
  BootedSystemContext,
  EshopListing,
  InstalledTitle,
  SwitchThemeTokens,
} from '../../nand/nandTypes';
import { GameArtwork } from '../GameArtwork';

// ============================================================================
// 1. NEWS APPLET (reads /sys/news/bulletin_feed.json from SYSTEM NAND)
// ============================================================================
export const NewsApplet: React.FC<{
  system: BootedSystemContext;
  theme: SwitchThemeTokens;
  onClose: () => void;
}> = ({ system, theme, onClose }) => {
  const [selectedId, setSelectedId] = useState(system.news[0]?.id ?? '');
  const article = system.news.find((n) => n.id === selectedId) ?? system.news[0];

  return (
    <div
      className="w-full h-full flex flex-col select-none"
      style={{ backgroundColor: theme.bgCanvas, color: theme.textPrimary }}
    >
      <div
        className="flex items-center justify-between px-7 py-3.5 border-b shrink-0"
        style={{ borderColor: theme.borderHairline }}
      >
        <div className="flex items-center gap-2.5">
          <Newspaper className="w-5 h-5 text-[#E60012]" />
          <h1 className="font-display font-bold text-lg">
            {system.localeStrings.NEWS_APP ?? 'News'}
          </h1>
        </div>
        <button
          onClick={() => {
            switchAudio.play('back');
            onClose();
          }}
          className="px-3.5 py-1.5 rounded-md text-xs font-semibold border cursor-pointer"
          style={{ borderColor: theme.borderHairline, backgroundColor: theme.bgTile }}
        >
          {system.localeStrings.BACK_HOME ?? 'B · Back to HOME'}
        </button>
      </div>

      <div className="flex-1 grid grid-cols-12 min-h-0">
        <div
          className="col-span-5 border-r p-4 space-y-2.5 overflow-y-auto thin-scrollbar"
          style={{ borderColor: theme.borderHairline }}
        >
          {system.news.map((item) => {
            const active = item.id === article?.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  switchAudio.play('tick');
                  setSelectedId(item.id);
                }}
                className={`w-full text-left p-3.5 rounded-lg border transition-colors cursor-pointer ${
                  active ? 'nx-focus-ring' : ''
                }`}
                style={{
                  backgroundColor: theme.bgTile,
                  borderColor: active ? '#0AB9E6' : theme.borderHairline,
                }}
              >
                <div className="text-[11px] font-semibold" style={{ color: item.accentColor }}>
                  {item.channel} · {item.date}
                </div>
                <div className="font-display font-bold text-sm mt-1">{item.title}</div>
                <div className="text-xs mt-1 line-clamp-2" style={{ color: theme.textSecondary }}>
                  {item.summary}
                </div>
              </button>
            );
          })}
        </div>

        <div className="col-span-7 p-6 overflow-y-auto thin-scrollbar">
          {article && (
            <div
              className="rounded-xl border p-6 space-y-4"
              style={{ backgroundColor: theme.bgTile, borderColor: theme.borderHairline }}
            >
              <div className="text-xs font-semibold" style={{ color: article.accentColor }}>
                {article.channel} · Published {article.date}
              </div>
              <h2 className="font-display text-xl font-bold">{article.title}</h2>
              <p className="text-sm leading-relaxed" style={{ color: theme.textSecondary }}>
                {article.summary}
              </p>
              <div
                className="pt-4 border-t text-sm leading-relaxed"
                style={{ borderColor: theme.borderHairline }}
              >
                {article.body}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 2. ESHOP / SOFTWARE CATALOG (installs titles directly into USER NAND)
// ============================================================================
export const EshopApplet: React.FC<{
  system: BootedSystemContext;
  theme: SwitchThemeTokens;
  onInstallTitle: (listing: EshopListing) => Promise<void>;
  onClose: () => void;
}> = ({ system, theme, onInstallTitle, onClose }) => {
  const [installingId, setInstallingId] = useState<string | null>(null);

  const installedIds = new Set(system.titles.map((t: InstalledTitle) => t.id));

  const handleInstall = async (item: EshopListing) => {
    setInstallingId(item.id);
    switchAudio.play('launch');
    await new Promise((r) => setTimeout(r, 450));
    await onInstallTitle(item);
    setInstallingId(null);
  };

  return (
    <div
      className="w-full h-full flex flex-col select-none"
      style={{ backgroundColor: theme.bgCanvas, color: theme.textPrimary }}
    >
      <div
        className="flex items-center justify-between px-7 py-3.5 border-b shrink-0"
        style={{ borderColor: theme.borderHairline }}
      >
        <div className="flex items-center gap-2.5">
          <ShoppingBag className="w-5 h-5 text-[#F59E0B]" />
          <h1 className="font-display font-bold text-lg">Nintendo eShop (NAND Catalog)</h1>
        </div>
        <button
          onClick={() => {
            switchAudio.play('back');
            onClose();
          }}
          className="px-3.5 py-1.5 rounded-md text-xs font-semibold border cursor-pointer"
          style={{ borderColor: theme.borderHairline, backgroundColor: theme.bgTile }}
        >
          {system.localeStrings.BACK_HOME ?? 'B · Back to HOME'}
        </button>
      </div>

      <div className="flex-1 p-6 overflow-y-auto thin-scrollbar">
        <div className="grid grid-cols-3 gap-5">
          {system.eshopCatalog.map((item) => {
            const isInstalled = installedIds.has(item.id);
            const isBusy = installingId === item.id;
            return (
              <div
                key={item.id}
                className="rounded-xl border overflow-hidden flex flex-col"
                style={{ backgroundColor: theme.bgTile, borderColor: theme.borderHairline }}
              >
                <div className="aspect-square w-full overflow-hidden">
                  <GameArtwork
                    artworkId={item.artworkId}
                    title={item.title}
                    artworkImages={system.artworkImages}
                  />
                </div>
                <div className="p-4 flex-1 flex flex-col justify-between gap-3">
                  <div>
                    <div className="font-display font-bold text-sm">{item.title}</div>
                    <div className="text-xs mt-0.5" style={{ color: theme.textSecondary }}>
                      {item.publisher} · {item.sizeMb} MB
                    </div>
                    <p className="text-xs mt-2 leading-relaxed" style={{ color: theme.textSecondary }}>
                      {item.description}
                    </p>
                  </div>
                  {isInstalled ? (
                    <div className="px-3 py-2 rounded-md bg-emerald-500/15 text-emerald-500 text-xs font-bold flex items-center justify-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4" />
                      Installed on USER NAND
                    </div>
                  ) : (
                    <button
                      onClick={() => handleInstall(item)}
                      disabled={isBusy}
                      className="px-3 py-2 rounded-md bg-[#F59E0B] hover:bg-[#d98a07] text-slate-950 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
                    >
                      <Download className="w-4 h-4" />
                      {isBusy ? 'Writing IDB Chunks…' : 'Download to NAND'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 3. ALBUM APPLET (reads/deletes /user/album/captures.json from USER NAND)
// ============================================================================
export const AlbumApplet: React.FC<{
  system: BootedSystemContext;
  theme: SwitchThemeTokens;
  onDeleteCapture: (id: string) => Promise<void>;
  onClose: () => void;
}> = ({ system, theme, onDeleteCapture, onClose }) => {
  const [selected, setSelected] = useState<AlbumCapture | null>(system.album[0] ?? null);

  return (
    <div
      className="w-full h-full flex flex-col select-none"
      style={{ backgroundColor: theme.bgCanvas, color: theme.textPrimary }}
    >
      <div
        className="flex items-center justify-between px-7 py-3.5 border-b shrink-0"
        style={{ borderColor: theme.borderHairline }}
      >
        <h1 className="font-display font-bold text-lg">
          Album ({system.album.length} Captures on USER NAND)
        </h1>
        <button
          onClick={() => {
            switchAudio.play('back');
            onClose();
          }}
          className="px-3.5 py-1.5 rounded-md text-xs font-semibold border cursor-pointer"
          style={{ borderColor: theme.borderHairline, backgroundColor: theme.bgTile }}
        >
          {system.localeStrings.BACK_HOME ?? 'B · Back to HOME'}
        </button>
      </div>

      <div className="flex-1 grid grid-cols-12 min-h-0">
        <div
          className="col-span-5 border-r p-4 grid grid-cols-2 gap-3 content-start overflow-y-auto thin-scrollbar"
          style={{ borderColor: theme.borderHairline }}
        >
          {system.album.map((cap) => {
            const active = selected?.id === cap.id;
            return (
              <button
                key={cap.id}
                onClick={() => {
                  switchAudio.play('tick');
                  setSelected(cap);
                }}
                className={`rounded-lg overflow-hidden border text-left cursor-pointer ${
                  active ? 'nx-focus-ring' : ''
                }`}
                style={{
                  borderColor: active ? '#0AB9E6' : theme.borderHairline,
                  backgroundColor: theme.bgTile,
                }}
              >
                <img
                  src={cap.dataUrl}
                  alt={cap.title}
                  referrerPolicy="no-referrer"
                  className="w-full aspect-video object-cover"
                />
                <div className="p-2 text-[11px] font-medium truncate">{cap.title}</div>
              </button>
            );
          })}
          {system.album.length === 0 && (
            <div className="col-span-2 text-xs p-4" style={{ color: theme.textSecondary }}>
              No captures yet. Use the Capture button or save artwork inside Tactile Sketchpad.
            </div>
          )}
        </div>

        <div className="col-span-7 p-6 flex flex-col justify-between">
          {selected ? (
            <>
              <div
                className="rounded-xl overflow-hidden border"
                style={{ borderColor: theme.borderHairline, backgroundColor: '#000' }}
              >
                <img
                  src={selected.dataUrl}
                  alt={selected.title}
                  referrerPolicy="no-referrer"
                  className="w-full aspect-video object-contain"
                />
              </div>
              <div className="flex items-center justify-between pt-4">
                <div>
                  <div className="font-display font-bold text-sm">{selected.title}</div>
                  <div className="text-xs" style={{ color: theme.textSecondary }}>
                    {selected.gameTitle} · {new Date(selected.capturedAt).toLocaleString()}
                  </div>
                </div>
                <button
                  onClick={async () => {
                    switchAudio.play('back');
                    await onDeleteCapture(selected.id);
                    const next = system.album.find((a) => a.id !== selected.id) ?? null;
                    setSelected(next);
                  }}
                  className="px-3 py-1.5 rounded-md bg-red-600/15 text-red-500 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete Capture
                </button>
              </div>
            </>
          ) : (
            <div className="m-auto text-sm" style={{ color: theme.textSecondary }}>
              Select a capture to inspect
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 4. CONTROLLERS APPLET (Joy-Con Hardware & HID Input Test)
// ============================================================================
export const ControllersApplet: React.FC<{
  system: BootedSystemContext;
  theme: SwitchThemeTokens;
  onClose: () => void;
}> = ({ system, theme, onClose }) => {
  const [paired, setPaired] = useState(true);
  const [vibrating, setVibrating] = useState<'L' | 'R' | null>(null);

  const triggerTest = (side: 'L' | 'R') => {
    switchAudio.play('click');
    setVibrating(side);
    setTimeout(() => setVibrating(null), 320);
  };

  return (
    <div
      className="w-full h-full flex flex-col select-none"
      style={{ backgroundColor: theme.bgCanvas, color: theme.textPrimary }}
    >
      <div
        className="flex items-center justify-between px-7 py-3.5 border-b shrink-0"
        style={{ borderColor: theme.borderHairline }}
      >
        <div className="flex items-center gap-2.5">
          <Gamepad2 className="w-5 h-5 text-[#0AB9E6]" />
          <h1 className="font-display font-bold text-lg">
            {system.localeStrings.CONTROLLERS_APP ?? 'Controllers'} (hid.kip1 · {system.hardwareCal.railModel})
          </h1>
        </div>
        <button
          onClick={() => {
            switchAudio.play('back');
            onClose();
          }}
          className="px-3.5 py-1.5 rounded-md text-xs font-semibold border cursor-pointer"
          style={{ borderColor: theme.borderHairline, backgroundColor: theme.bgTile }}
        >
          {system.localeStrings.BACK_HOME ?? 'B · Back to HOME'}
        </button>
      </div>

      <div className="flex-1 p-6 grid grid-cols-12 gap-6 items-center">
        <div className="col-span-6 flex items-center justify-center gap-6">
          {/* Left Joy-Con */}
          <button
            onClick={() => triggerTest('L')}
            className={`w-24 h-56 rounded-l-[2.2rem] rounded-r-lg bg-[#00C3E3] text-slate-950 p-4 flex flex-col justify-between shadow-md transition-transform cursor-pointer ${
              vibrating === 'L' ? '-translate-y-1.5 scale-105' : ''
            }`}
          >
            <div className="w-3 h-3 rounded-full bg-slate-900/40 self-end" />
            <div className="w-10 h-10 rounded-full bg-slate-900 mx-auto" />
            <div className="grid grid-cols-3 gap-1 w-12 mx-auto">
              <div />
              <div className="w-3 h-3 rounded-full bg-slate-900" />
              <div />
              <div className="w-3 h-3 rounded-full bg-slate-900" />
              <div />
              <div className="w-3 h-3 rounded-full bg-slate-900" />
              <div />
              <div className="w-3 h-3 rounded-full bg-slate-900" />
              <div />
            </div>
            <div className="text-[10px] font-bold text-center">L · TEST</div>
          </button>

          {/* Right Joy-Con */}
          <button
            onClick={() => triggerTest('R')}
            className={`w-24 h-56 rounded-r-[2.2rem] rounded-l-lg bg-[#FF4554] text-white p-4 flex flex-col justify-between shadow-md transition-transform cursor-pointer ${
              vibrating === 'R' ? '-translate-y-1.5 scale-105' : ''
            }`}
          >
            <div className="text-sm font-bold leading-none">+</div>
            <div className="grid grid-cols-3 gap-1 w-12 mx-auto text-[8px] font-bold">
              <div />
              <div className="w-3.5 h-3.5 rounded-full bg-slate-900 flex items-center justify-center">X</div>
              <div />
              <div className="w-3.5 h-3.5 rounded-full bg-slate-900 flex items-center justify-center">Y</div>
              <div />
              <div className="w-3.5 h-3.5 rounded-full bg-slate-900 flex items-center justify-center">A</div>
              <div />
              <div className="w-3.5 h-3.5 rounded-full bg-slate-900 flex items-center justify-center">B</div>
              <div />
            </div>
            <div className="w-10 h-10 rounded-full bg-slate-900 mx-auto" />
            <div className="text-[10px] font-bold text-center">R · TEST</div>
          </button>
        </div>

        <div className="col-span-6 space-y-4">
          <div
            className="p-4 rounded-xl border space-y-2"
            style={{ backgroundColor: theme.bgTile, borderColor: theme.borderHairline }}
          >
            <div className="font-display font-bold text-sm">
              Joy-Con (L/R) · {paired ? 'Attached to Console Rails' : 'Wireless Paired'}
            </div>
            <p className="text-xs leading-relaxed" style={{ color: theme.textSecondary }}>
              Keyboard shortcuts: Arrow Keys navigate tiles, Enter/Space acts as A (OK),
              Backspace/Esc acts as B (Back), and the hardware Joy-Con buttons on the left and right rails are fully clickable.
            </p>
            <div className="pt-2 flex gap-2">
              <button
                onClick={() => {
                  switchAudio.play('click');
                  setPaired((p) => !p);
                }}
                className="px-3.5 py-1.5 rounded-md bg-[#0AB9E6] text-slate-950 text-xs font-bold cursor-pointer"
              >
                {paired ? 'Detach Virtual Rails' : 'Snap Rails (Click)'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 5. USER PROFILE SWITCHER MODAL
// ============================================================================
export const UserProfileModal: React.FC<{
  system: BootedSystemContext;
  theme: SwitchThemeTokens;
  onSelectUser: (id: string) => Promise<void>;
  onClose: () => void;
}> = ({ system, theme, onSelectUser, onClose }) => {
  return (
    <div className="absolute inset-0 z-40 bg-black/55 flex items-center justify-center p-6">
      <div
        className="w-full max-w-lg rounded-xl border p-6 shadow-xl space-y-4"
        style={{ backgroundColor: theme.bgModal, borderColor: theme.borderHairline, color: theme.textPrimary }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <UserCheck className="w-5 h-5 text-[#0AB9E6]" />
            <h2 className="font-display font-bold text-base">Select Active User</h2>
          </div>
          <button
            onClick={onClose}
            className="text-xs font-semibold px-2.5 py-1 rounded border cursor-pointer"
            style={{ borderColor: theme.borderHairline }}
          >
            Close
          </button>
        </div>

        <div className="space-y-2.5">
          {system.profiles.map((u) => {
            const active = u.id === system.settings.activeUserId;
            const glyphUrl = system.avatarGlyphs[u.avatarGlyph];
            return (
              <button
                key={u.id}
                onClick={async () => {
                  switchAudio.play('select');
                  await onSelectUser(u.id);
                  onClose();
                }}
                className={`w-full p-3.5 rounded-lg border flex items-center justify-between cursor-pointer ${
                  active ? 'nx-focus-ring' : ''
                }`}
                style={{
                  backgroundColor: theme.bgTile,
                  borderColor: active ? '#0AB9E6' : theme.borderHairline,
                }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-white font-display font-bold overflow-hidden"
                    style={{ backgroundColor: u.avatarBg }}
                  >
                    {glyphUrl ? (
                      <img
                        src={glyphUrl}
                        alt={u.name}
                        className="w-6 h-6 object-contain pointer-events-none"
                      />
                    ) : (
                      u.name.slice(0, 1).toUpperCase()
                    )}
                  </div>
                  <div className="text-left">
                    <div className="font-display font-bold text-sm">{u.name}</div>
                    <div className="text-xs font-mono-tabular" style={{ color: theme.textSecondary }}>
                      {u.friendCode} · {u.playHoursTotal}h total play
                    </div>
                  </div>
                </div>
                {active && (
                  <span className="text-xs font-bold text-[#0AB9E6]">Active</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
