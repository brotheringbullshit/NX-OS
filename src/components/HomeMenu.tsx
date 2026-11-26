import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BatteryCharging,
  Disc,
  Gamepad2,
  Image as ImageIcon,
  Moon,
  Newspaper,
  Plane,
  Power,
  RefreshCw,
  Settings,
  ShoppingBag,
  SlidersHorizontal,
  Terminal,
  Wifi,
} from 'lucide-react';
import { switchAudio } from '../audio/switchAudio';
import {
  AlbumCapture,
  BootedSystemContext,
  ConsoleSettings,
  EshopListing,
  InstalledTitle,
  UserProfile,
} from '../nand/nandTypes';
import { GameArtwork } from './GameArtwork';
import { SettingsApplet } from './applets/SettingsApplet';
import {
  AlbumApplet,
  ControllersApplet,
  EshopApplet,
  NewsApplet,
  UserProfileModal,
} from './applets/SystemApplets';
import { MiniGameRunner } from './games/MiniGameRunner';

interface HomeMenuProps {
  system: BootedSystemContext;
  onUpdateSettings: (patch: Partial<ConsoleSettings>) => Promise<void>;
  onUpdateProfiles: (profiles: UserProfile[]) => Promise<void>;
  onInstallTitle: (listing: EshopListing) => Promise<void>;
  onDeleteTitle: (titleId: string) => Promise<void>;
  onSaveScore: (titleId: string, score: number) => Promise<void>;
  onSaveCapture: (capture: AlbumCapture) => Promise<void>;
  onDeleteCapture: (id: string) => Promise<void>;
  onReboot: (mode: 'NORMAL' | 'MAINTENANCE') => void;
  onFactoryReset: () => Promise<void>;
  externalButtonSignal: { button: string; seq: number } | null;
}

type ActiveApplet =
  | null
  | 'news'
  | 'eshop'
  | 'album'
  | 'controllers'
  | 'settings';

const APPLET_DEFS: {
  id: 'news' | 'eshop' | 'album' | 'controllers' | 'settings' | 'power';
  strKey: string;
  fallback: string;
  accent?: string;
}[] = [
  { id: 'news', strKey: 'NEWS_APP', fallback: 'News', accent: '#E60012' },
  { id: 'eshop', strKey: 'ESHOP_APP', fallback: 'Nintendo eShop', accent: '#F59E0B' },
  { id: 'album', strKey: 'ALBUM_APP', fallback: 'Album', accent: '#0AB9E6' },
  { id: 'controllers', strKey: 'CONTROLLERS_APP', fallback: 'Controllers' },
  { id: 'settings', strKey: 'SYSTEM_SETTINGS', fallback: 'System Settings' },
  { id: 'power', strKey: 'POWER_APP', fallback: 'Sleep / Power' },
];

export const HomeMenu: React.FC<HomeMenuProps> = ({
  system,
  onUpdateSettings,
  onUpdateProfiles,
  onInstallTitle,
  onDeleteTitle,
  onSaveScore,
  onSaveCapture,
  onDeleteCapture,
  onReboot,
  onFactoryReset,
  externalButtonSignal,
}) => {
  const theme =
    system.settings.theme === 'dark' ? system.themes.dark : system.themes.light;
  const strings = system.localeStrings;
  const applets = APPLET_DEFS.map((a) => ({
    ...a,
    label: strings[a.strKey] ?? a.fallback,
  }));

  const [focusRow, setFocusRow] = useState<'GAMES' | 'APPLETS'>('GAMES');
  const [selectedTileIdx, setSelectedTileIdx] = useState(0);
  const [selectedAppletIdx, setSelectedAppletIdx] = useState(4);
  const [activeApplet, setActiveApplet] = useState<ActiveApplet>(null);
  const [runningTitle, setRunningTitle] = useState<InstalledTitle | null>(null);
  const [showUserModal, setShowUserModal] = useState(false);
  const [showPowerModal, setShowPowerModal] = useState(false);
  const [showQuickSettings, setShowQuickSettings] = useState(false);
  const [showSoftwareOptions, setShowSoftwareOptions] = useState<InstalledTitle | null>(
    null
  );
  const [sleeping, setSleeping] = useState(false);
  const [nowTime, setNowTime] = useState(() => new Date());

  const carouselRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNowTime(new Date()), 10_000);
    return () => clearInterval(id);
  }, []);

  const activeUser =
    system.profiles.find((p) => p.id === system.settings.activeUserId) ??
    system.profiles[0];

  const totalSlots = Math.max(system.qlaunchConfig.gridSlots || 8, system.titles.length + 2);

  // Keep selected tile scrolled smoothly into view
  useEffect(() => {
    const container = carouselRef.current;
    if (!container) return;
    const child = container.children[selectedTileIdx] as HTMLElement | undefined;
    if (child) {
      child.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [selectedTileIdx]);

  const launchSelectedTile = useCallback(
    (idx: number) => {
      const title = system.titles[idx];
      if (!title) return;
      switchAudio.play('launch');
      setRunningTitle(title);
    },
    [system.titles]
  );

  const openSelectedApplet = useCallback((idx: number) => {
    const ap = applets[idx];
    if (!ap) return;
    if (ap.id === 'power') {
      switchAudio.play('modal');
      setShowPowerModal(true);
    } else {
      switchAudio.play('select');
      setActiveApplet(ap.id);
    }
  }, [applets]);

  const handleActionButton = useCallback(
    (btn: string) => {
      if (sleeping) {
        if (btn === 'A' || btn === 'HOME' || btn === 'POWER') {
          switchAudio.playBootChime(system.bootChime);
          setSleeping(false);
        }
        return;
      }

      if (btn === 'HOME') {
        switchAudio.play('modal');
        setRunningTitle(null);
        setActiveApplet(null);
        setShowPowerModal(false);
        setShowUserModal(false);
        setShowSoftwareOptions(null);
        setShowQuickSettings(false);
        return;
      }

      if (btn === 'POWER') {
        switchAudio.play('modal');
        setShowPowerModal((v) => !v);
        return;
      }

      // When running a game or applet, only B backs out of applets (games handle arrow keys)
      if (runningTitle) return;
      if (activeApplet) {
        if (btn === 'B') {
          switchAudio.play('back');
          setActiveApplet(null);
        }
        return;
      }

      if (showPowerModal || showUserModal || showSoftwareOptions || showQuickSettings) {
        if (btn === 'B') {
          switchAudio.play('back');
          setShowPowerModal(false);
          setShowUserModal(false);
          setShowSoftwareOptions(null);
          setShowQuickSettings(false);
        }
        return;
      }

      if (btn === 'LEFT') {
        switchAudio.play('tick');
        if (focusRow === 'GAMES') {
          setSelectedTileIdx((i) => Math.max(0, i - 1));
        } else {
          setSelectedAppletIdx((i) => Math.max(0, i - 1));
        }
      } else if (btn === 'RIGHT') {
        switchAudio.play('tick');
        if (focusRow === 'GAMES') {
          setSelectedTileIdx((i) => Math.min(system.titles.length - 1, i + 1));
        } else {
          setSelectedAppletIdx((i) => Math.min(applets.length - 1, i + 1));
        }
      } else if (btn === 'DOWN') {
        if (focusRow === 'GAMES') {
          switchAudio.play('tick');
          setFocusRow('APPLETS');
        }
      } else if (btn === 'UP') {
        if (focusRow === 'APPLETS') {
          switchAudio.play('tick');
          setFocusRow('GAMES');
        }
      } else if (btn === 'A') {
        if (focusRow === 'GAMES') {
          launchSelectedTile(selectedTileIdx);
        } else {
          openSelectedApplet(selectedAppletIdx);
        }
      } else if (btn === 'PLUS') {
        const title = system.titles[selectedTileIdx];
        if (focusRow === 'GAMES' && title) {
          switchAudio.play('modal');
          setShowSoftwareOptions(title);
        }
      }
    },
    [
      activeApplet,
      applets.length,
      focusRow,
      launchSelectedTile,
      openSelectedApplet,
      runningTitle,
      selectedAppletIdx,
      selectedTileIdx,
      showPowerModal,
      showQuickSettings,
      showSoftwareOptions,
      showUserModal,
      sleeping,
      system.bootChime,
      system.titles,
    ]
  );

  // Keyboard navigation on HOME Menu
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Avoid stealing arrows when typing in Settings input
      if (
        document.activeElement &&
        ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)
      ) {
        return;
      }
      if (runningTitle) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleActionButton('LEFT');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleActionButton('RIGHT');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        handleActionButton('DOWN');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        handleActionButton('UP');
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleActionButton('A');
      } else if (e.key === 'Backspace' || e.key === 'Escape') {
        e.preventDefault();
        handleActionButton('B');
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        handleActionButton('PLUS');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleActionButton, runningTitle]);

  // Hardware Joy-Con button presses
  useEffect(() => {
    if (!externalButtonSignal) return;
    handleActionButton(externalButtonSignal.button);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalButtonSignal?.seq]);

  const formattedClock = nowTime.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: !system.settings.clock24h,
  });

  // Render active full-screen software or applet
  if (sleeping) {
    return (
      <button
        onClick={() => handleActionButton('A')}
        className="w-full h-full bg-[#060709] text-slate-300 flex flex-col items-center justify-center gap-3 cursor-pointer select-none"
      >
        <Moon className="w-10 h-10 text-slate-500" />
        <div className="font-display font-semibold text-base">
          {strings.SLEEP ?? 'Sleep Mode'}
        </div>
        <div className="text-xs text-slate-500">
          {strings.SLEEP_HINT ?? 'Click screen or press A / HOME to wake Horizon-NX'}
        </div>
      </button>
    );
  }

  if (runningTitle) {
    // Keep title synced with latest scores
    const liveTitle =
      system.titles.find((t) => t.id === runningTitle.id) ?? runningTitle;
    return (
      <MiniGameRunner
        title={liveTitle}
        system={system}
        theme={theme}
        onSaveScore={onSaveScore}
        onSaveCapture={onSaveCapture}
        onExit={() => setRunningTitle(null)}
      />
    );
  }

  if (activeApplet === 'settings') {
    return (
      <SettingsApplet
        system={system}
        theme={theme}
        onUpdateSettings={onUpdateSettings}
        onUpdateProfiles={onUpdateProfiles}
        onDeleteTitle={onDeleteTitle}
        onReboot={onReboot}
        onFactoryReset={onFactoryReset}
        onClose={() => setActiveApplet(null)}
      />
    );
  }
  if (activeApplet === 'news') {
    return (
      <NewsApplet
        system={system}
        theme={theme}
        onClose={() => setActiveApplet(null)}
      />
    );
  }
  if (activeApplet === 'eshop') {
    return (
      <EshopApplet
        system={system}
        theme={theme}
        onInstallTitle={onInstallTitle}
        onClose={() => setActiveApplet(null)}
      />
    );
  }
  if (activeApplet === 'album') {
    return (
      <AlbumApplet
        system={system}
        theme={theme}
        onDeleteCapture={onDeleteCapture}
        onClose={() => setActiveApplet(null)}
      />
    );
  }
  if (activeApplet === 'controllers') {
    return (
      <ControllersApplet
        system={system}
        theme={theme}
        onClose={() => setActiveApplet(null)}
      />
    );
  }

  const focusedTitle = system.titles[selectedTileIdx];

  return (
    <div
      className="w-full h-full flex flex-col justify-between relative select-none overflow-hidden transition-colors duration-200"
      style={{
        backgroundColor: theme.bgCanvas,
        color: theme.textPrimary,
      }}
    >
      {/* 1. TOP STATUS BAR */}
      <header className="flex items-center justify-between px-8 pt-5 pb-2 shrink-0">
        {/* Left: User Profile Avatars */}
        <div className="flex items-center gap-3">
          {system.profiles.map((prof) => {
            const isActive = prof.id === activeUser?.id;
            const glyphUrl = system.avatarGlyphs[prof.avatarGlyph];
            return (
              <button
                key={prof.id}
                onClick={() => {
                  switchAudio.play('modal');
                  setShowUserModal(true);
                }}
                title={`${prof.name}'s Page`}
                className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-display font-bold text-sm transition-transform cursor-pointer overflow-hidden ${
                  isActive
                    ? 'ring-2 ring-[#0AB9E6] scale-105'
                    : 'opacity-70 hover:opacity-100'
                }`}
                style={{ backgroundColor: prof.avatarBg }}
              >
                {glyphUrl ? (
                  <img
                    src={glyphUrl}
                    alt={prof.name}
                    className="w-6 h-6 object-contain pointer-events-none"
                  />
                ) : (
                  prof.name.slice(0, 1).toUpperCase()
                )}
              </button>
            );
          })}
          {activeUser && (
            <span className="text-xs font-semibold ml-1" style={{ color: theme.textSecondary }}>
              {activeUser.name}&rsquo;s Page
            </span>
          )}
        </div>

        {/* Right: Clock, Wi-Fi / Airplane, Battery */}
        <div className="flex items-center gap-4 text-sm font-semibold">
          <span className="font-mono-tabular tracking-tight">{formattedClock}</span>
          {system.settings.airplaneMode ? (
            <Plane className="w-4 h-4 text-amber-500" aria-label="Airplane Mode On" />
          ) : (
            <Wifi className="w-4 h-4" aria-label="Wi-Fi Connected" />
          )}
          <div
            className="flex items-center gap-1.5 font-mono-tabular text-xs"
            title={`NXVM Fuel Gauge: ${system.batteryTelemetry.estimatedMinutesLeft}m left · ${system.hardwareCal.battery.model} (${system.batteryTelemetry.healthPercent}% health)`}
          >
            <span>{system.batteryTelemetry.batteryPercent}%</span>
            <BatteryCharging className="w-5 h-5 text-emerald-500" />
          </div>
          <button
            onClick={() => {
              switchAudio.play('modal');
              setShowQuickSettings(true);
            }}
            className="p-1.5 rounded-md hover:bg-black/10 transition-colors cursor-pointer"
            title={strings.QUICK_SETTINGS ?? 'Quick Settings'}
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* 2. CENTER HORIZONTAL GAME TILE CAROUSEL */}
      <main className="flex-1 flex flex-col justify-center min-h-0 px-8">
        {/* Selected Software Title Header */}
        <div className="h-8 mb-2 flex items-center gap-2">
          {focusRow === 'GAMES' && focusedTitle && (
            <>
              {focusedTitle.isGameCard && (
                <Disc className="w-4 h-4 text-[#0AB9E6] shrink-0" />
              )}
              <span className="font-display font-bold text-lg text-[#0AB9E6] truncate">
                {focusedTitle.title}
              </span>
              {focusedTitle.highScore !== undefined && (
                <span
                  className="text-xs font-mono-tabular ml-2"
                  style={{ color: theme.textSecondary }}
                >
                  · Best {focusedTitle.highScore}
                </span>
              )}
            </>
          )}
        </div>

        {/* Horizontal Carousel */}
        <div
          ref={carouselRef}
          className="flex items-center gap-3.5 overflow-x-auto no-scrollbar py-2 px-1"
        >
          {Array.from({ length: totalSlots }).map((_, idx) => {
            const title = system.titles[idx];
            const isFocused = focusRow === 'GAMES' && selectedTileIdx === idx && !!title;

            if (!title) {
              return (
                <div
                  key={`empty-${idx}`}
                  className="w-44 h-44 shrink-0 rounded-sm border"
                  style={{
                    backgroundColor: theme.bgTileEmpty,
                    borderColor: theme.borderHairline,
                  }}
                />
              );
            }

            return (
              <button
                key={title.id}
                onClick={() => {
                  setFocusRow('GAMES');
                  if (selectedTileIdx === idx) {
                    launchSelectedTile(idx);
                  } else {
                    switchAudio.play('tick');
                    setSelectedTileIdx(idx);
                  }
                }}
                onDoubleClick={() => launchSelectedTile(idx)}
                className={`w-44 h-44 shrink-0 rounded-sm overflow-hidden relative transition-transform duration-150 cursor-pointer focus:outline-none ${
                  isFocused ? 'nx-focus-ring scale-[1.03] z-10' : 'hover:scale-[1.01]'
                }`}
                style={{
                  backgroundColor: theme.bgTile,
                }}
              >
                <GameArtwork
                  artworkId={title.artworkId}
                  title={title.title}
                  artworkImages={system.artworkImages}
                />
              </button>
            );
          })}
        </div>
      </main>

      {/* 3. BOTTOM CIRCULAR APPLET DOCK */}
      <section className="px-8 pb-3 flex flex-col items-center shrink-0">
        <div className="flex items-center justify-center gap-5">
          {applets.map((ap, idx) => {
            const isFocused = focusRow === 'APPLETS' && selectedAppletIdx === idx;
            return (
              <div key={ap.id} className="flex flex-col items-center gap-1.5">
                <button
                  onClick={() => {
                    setFocusRow('APPLETS');
                    setSelectedAppletIdx(idx);
                    openSelectedApplet(idx);
                  }}
                  className={`w-13 h-13 rounded-full flex items-center justify-center shadow-sm border transition-transform duration-150 cursor-pointer ${
                    isFocused ? 'nx-focus-ring scale-105' : 'hover:scale-105'
                  }`}
                  style={{
                    backgroundColor: theme.bgAppletBtn,
                    borderColor: theme.borderHairline,
                    color: ap.accent ?? theme.textPrimary,
                  }}
                  aria-label={ap.label}
                >
                  {ap.id === 'news' && <Newspaper className="w-5 h-5" />}
                  {ap.id === 'eshop' && <ShoppingBag className="w-5 h-5" />}
                  {ap.id === 'album' && <ImageIcon className="w-5 h-5" />}
                  {ap.id === 'controllers' && <Gamepad2 className="w-5 h-5" />}
                  {ap.id === 'settings' && <Settings className="w-5 h-5" />}
                  {ap.id === 'power' && <Power className="w-5 h-5" />}
                </button>
                <span
                  className="text-[11px] font-semibold h-4 whitespace-nowrap"
                  style={{
                    color: isFocused ? '#0AB9E6' : 'transparent',
                  }}
                >
                  {ap.label}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* 4. BOTTOM CONTROLLER HINT BAR */}
      <footer
        className="flex items-center justify-between px-8 py-2.5 border-t text-xs shrink-0"
        style={{ borderColor: theme.borderHairline }}
      >
        <div className="flex items-center gap-2" style={{ color: theme.textSecondary }}>
          <Gamepad2 className="w-4 h-4" />
          <span className="font-mono-tabular">
            {system.osManifest.codename} {system.osManifest.osVersion} ·{' '}
            {system.totalChunksRead} NAND chunks verified
          </span>
        </div>

        <div className="flex items-center gap-5 font-semibold">
          {focusRow === 'GAMES' && focusedTitle && (
            <button
              onClick={() => handleActionButton('PLUS')}
              className="flex items-center gap-1.5 hover:opacity-80 cursor-pointer"
            >
              <span className="w-5 h-5 rounded-full bg-current/15 flex items-center justify-center text-[11px] font-bold">
                +
              </span>
              <span>{strings.OPTIONS ?? 'Options'}</span>
            </button>
          )}
          <button
            onClick={() => handleActionButton('A')}
            className="flex items-center gap-1.5 hover:opacity-80 cursor-pointer"
          >
            <span
              className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold text-white"
              style={{ backgroundColor: theme.textPrimary, color: theme.bgCanvas }}
            >
              A
            </span>
            <span>{strings.START ?? 'Start'}</span>
          </button>
        </div>
      </footer>

      {/* MODALS & OVERLAYS */}
      {showUserModal && (
        <UserProfileModal
          system={system}
          theme={theme}
          onSelectUser={(id) => onUpdateSettings({ activeUserId: id })}
          onClose={() => setShowUserModal(false)}
        />
      )}

      {showSoftwareOptions && (
        <div className="absolute inset-0 z-40 bg-black/55 flex items-center justify-center p-6">
          <div
            className="w-full max-w-md rounded-xl border p-6 shadow-xl space-y-4"
            style={{ backgroundColor: theme.bgModal, borderColor: theme.borderHairline }}
          >
            <div className="flex items-center gap-3">
              <div className="w-16 h-16 rounded overflow-hidden shrink-0">
                <GameArtwork
                  artworkId={showSoftwareOptions.artworkId}
                  title={showSoftwareOptions.title}
                  artworkImages={system.artworkImages}
                />
              </div>
              <div>
                <h2 className="font-display font-bold text-base">
                  {showSoftwareOptions.title}
                </h2>
                <div className="text-xs" style={{ color: theme.textSecondary }}>
                  {showSoftwareOptions.publisher} · v{showSoftwareOptions.version} ·{' '}
                  {showSoftwareOptions.sizeMb} MB
                </div>
              </div>
            </div>

            <div
              className="rounded-lg border p-3 text-xs space-y-1.5 font-mono-tabular"
              style={{ borderColor: theme.borderHairline, backgroundColor: theme.bgTile }}
            >
              <div>Save File Path: {showSoftwareOptions.saveFilePath}</div>
              <div>
                Play Time: {Math.floor(showSoftwareOptions.playMinutes / 60)}h{' '}
                {showSoftwareOptions.playMinutes % 60}m
              </div>
              {showSoftwareOptions.highScore !== undefined && (
                <div>High Score: {showSoftwareOptions.highScore}</div>
              )}
            </div>

            <div className="flex items-center justify-between pt-2">
              {system.titles.length > 1 ? (
                <button
                  onClick={async () => {
                    await onDeleteTitle(showSoftwareOptions.id);
                    setShowSoftwareOptions(null);
                    setSelectedTileIdx(0);
                  }}
                  className="px-3 py-1.5 rounded text-xs font-semibold text-red-500 hover:bg-red-500/10 cursor-pointer"
                >
                  Delete Software
                </button>
              ) : (
                <div />
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowSoftwareOptions(null)}
                  className="px-3.5 py-1.5 rounded border text-xs font-semibold cursor-pointer"
                  style={{ borderColor: theme.borderHairline }}
                >
                  {strings.CLOSE ?? 'Close'}
                </button>
                <button
                  onClick={() => {
                    const t = showSoftwareOptions;
                    setShowSoftwareOptions(null);
                    setRunningTitle(t);
                  }}
                  className="px-4 py-1.5 rounded bg-[#0AB9E6] text-slate-950 text-xs font-bold cursor-pointer"
                >
                  Launch Software
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showPowerModal && (
        <div className="absolute inset-0 z-40 bg-black/55 flex items-center justify-center p-6">
          <div
            className="w-full max-w-sm rounded-xl border p-5 shadow-xl space-y-2.5"
            style={{ backgroundColor: theme.bgModal, borderColor: theme.borderHairline }}
          >
            <h2 className="font-display font-bold text-base pb-1">
              {strings.POWER_APP ?? 'Power Options'}
            </h2>
            <button
              onClick={() => {
                switchAudio.play('sleep');
                setShowPowerModal(false);
                setSleeping(true);
              }}
              className="w-full p-3 rounded-lg border text-left text-sm font-semibold flex items-center gap-2.5 hover:border-[#0AB9E6] cursor-pointer"
              style={{ backgroundColor: theme.bgTile, borderColor: theme.borderHairline }}
            >
              <Moon className="w-4 h-4 text-[#0AB9E6]" />
              {strings.SLEEP ?? 'Sleep Mode'}
            </button>
            <button
              onClick={() => {
                switchAudio.play('launch');
                setShowPowerModal(false);
                onReboot('NORMAL');
              }}
              className="w-full p-3 rounded-lg border text-left text-sm font-semibold flex items-center gap-2.5 hover:border-[#0AB9E6] cursor-pointer"
              style={{ backgroundColor: theme.bgTile, borderColor: theme.borderHairline }}
            >
              <RefreshCw className="w-4 h-4 text-[#0AB9E6]" />
              {strings.RESTART ?? 'Restart'} (Stage 1 → Stage 2)
            </button>
            <button
              onClick={() => {
                switchAudio.play('modal');
                setShowPowerModal(false);
                onReboot('MAINTENANCE');
              }}
              className="w-full p-3 rounded-lg border text-left text-sm font-semibold flex items-center gap-2.5 hover:border-[#0AB9E6] cursor-pointer"
              style={{ backgroundColor: theme.bgTile, borderColor: theme.borderHairline }}
            >
              <Terminal className="w-4 h-4 text-amber-500" />
              Reboot to Bootloader / NAND Utility
            </button>
            <button
              onClick={() => {
                switchAudio.play('back');
                setShowPowerModal(false);
              }}
              className="w-full py-2 text-xs font-semibold opacity-75 hover:opacity-100 cursor-pointer"
            >
              {strings.CANCEL ?? 'Cancel'}
            </button>
          </div>
        </div>
      )}

      {/* Quick Settings Right Drawer */}
      {showQuickSettings && (
        <div
          className="absolute inset-0 z-40 bg-black/45 flex justify-end"
          onClick={() => setShowQuickSettings(false)}
        >
          <div
            className="w-72 h-full border-l p-5 flex flex-col justify-between shadow-2xl"
            style={{ backgroundColor: theme.bgModal, borderColor: theme.borderHairline }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-5">
              <div className="font-display font-bold text-base">
                {strings.QUICK_SETTINGS ?? 'Quick Settings'}
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1.5">
                  <span>Brightness</span>
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

              <div>
                <div className="flex justify-between text-xs mb-1.5">
                  <span>Volume</span>
                  <span className="font-mono-tabular">
                    {system.settings.muted ? 'Muted' : `${system.settings.volume}%`}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={system.settings.volume}
                  onChange={(e) =>
                    onUpdateSettings({ volume: Number(e.target.value), muted: false })
                  }
                  className="w-full accent-[#0AB9E6] cursor-pointer"
                />
              </div>

              <button
                onClick={() => {
                  switchAudio.play('select');
                  onUpdateSettings({ airplaneMode: !system.settings.airplaneMode });
                }}
                className="w-full p-3 rounded-lg border flex items-center justify-between text-xs font-semibold cursor-pointer"
                style={{ backgroundColor: theme.bgTile, borderColor: theme.borderHairline }}
              >
                <span>Airplane Mode</span>
                <span className="text-[#0AB9E6]">
                  {system.settings.airplaneMode ? 'On' : 'Off'}
                </span>
              </button>

              <button
                onClick={() => {
                  switchAudio.play('select');
                  onUpdateSettings({
                    theme: system.settings.theme === 'light' ? 'dark' : 'light',
                  });
                }}
                className="w-full p-3 rounded-lg border flex items-center justify-between text-xs font-semibold cursor-pointer"
                style={{ backgroundColor: theme.bgTile, borderColor: theme.borderHairline }}
              >
                <span>Theme</span>
                <span className="text-[#0AB9E6]">
                  {system.settings.theme === 'light' ? 'Basic White' : 'Basic Black'}
                </span>
              </button>
            </div>

            <button
              onClick={() => setShowQuickSettings(false)}
              className="w-full py-2 rounded-md bg-[#0AB9E6] text-slate-950 text-xs font-bold cursor-pointer"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
