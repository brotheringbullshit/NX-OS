import React, { useEffect, useState } from 'react';
import {
  Activity,
  Cpu,
  Maximize2,
  Minimize2,
  Power,
  RefreshCw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { nandStore } from '../nand/nandChunkStore';
import { NandIoEvent } from '../nand/nandTypes';

interface ConsoleShellProps {
  children: React.ReactNode;
  brightness: number;
  muted: boolean;
  dockedFullscreen: boolean;
  onToggleFullscreen: () => void;
  onToggleMute: () => void;
  onReboot: (mode: 'NORMAL' | 'MAINTENANCE') => void;
  onJoyConPress: (button: string) => void;
  activeStageLabel: string;
}

export const ConsoleShell: React.FC<ConsoleShellProps> = ({
  children,
  brightness,
  muted,
  dockedFullscreen,
  onToggleFullscreen,
  onToggleMute,
  onReboot,
  onJoyConPress,
  activeStageLabel,
}) => {
  const [showBusMonitor, setShowBusMonitor] = useState(false);
  const [ioEvents, setIoEvents] = useState<NandIoEvent[]>(() =>
    nandStore.getRecentIo()
  );

  useEffect(() => {
    return nandStore.subscribeIo((evt) => {
      setIoEvents((prev) => [evt, ...prev].slice(0, 40));
    });
  }, []);

  return (
    <div className="min-h-screen bg-[#111317] text-slate-100 flex flex-col">
      {/* Minimal Hardware Control Bar (outside console screen) */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-slate-800/80 bg-[#15181E] shrink-0">
        <div className="flex items-center gap-4">
          <span className="font-display font-bold text-sm tracking-tight text-white whitespace-nowrap">
            NX-OS Console Simulator
          </span>
          <span className="text-xs font-mono-tabular text-slate-400 hidden sm:inline whitespace-nowrap">
            {activeStageLabel}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowBusMonitor((v) => !v)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium border flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap ${
              showBusMonitor
                ? 'bg-[#0AB9E6]/15 border-[#0AB9E6] text-[#0AB9E6]'
                : 'bg-slate-800/80 border-slate-700 text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            IDB NAND Bus
          </button>

          <button
            onClick={() => onReboot('MAINTENANCE')}
            className="px-3 py-1.5 rounded-md bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            <Cpu className="w-3.5 h-3.5" />
            Bootloader
          </button>

          <button
            onClick={() => onReboot('NORMAL')}
            className="px-3 py-1.5 rounded-md bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Cold Reboot
          </button>

          <button
            onClick={onToggleMute}
            className="p-1.5 rounded-md bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-slate-200 cursor-pointer"
            title={muted ? 'Unmute Audio' : 'Mute Audio'}
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          <button
            onClick={onToggleFullscreen}
            className="p-1.5 rounded-md bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-slate-200 cursor-pointer"
            title={dockedFullscreen ? 'Handheld Console View' : 'Docked Wide Display'}
          >
            {dockedFullscreen ? (
              <Minimize2 className="w-4 h-4" />
            ) : (
              <Maximize2 className="w-4 h-4" />
            )}
          </button>
        </div>
      </header>

      {/* Main Console Stage */}
      <main className="flex-1 flex flex-col items-center justify-center p-4 lg:p-6 gap-5">
        {dockedFullscreen ? (
          /* Docked Wide Display Mode */
          <div className="w-full max-w-[1160px] aspect-video rounded-xl overflow-hidden border border-slate-700 shadow-2xl relative bg-black">
            <div
              className="w-full h-full transition-[filter] duration-150"
              style={{ filter: `brightness(${brightness}%)` }}
            >
              {children}
            </div>
          </div>
        ) : (
          /* Handheld Switch Console Hardware Frame */
          <div className="w-full max-w-[1220px] flex items-stretch justify-center select-none">
            {/* Left Neon Blue Joy-Con */}
            <div className="hidden md:flex w-28 lg:w-32 bg-[#00C3E3] rounded-l-[3rem] border-y-2 border-l-2 border-[#009BB5] p-3.5 flex-col justify-between text-slate-950 shadow-xl shrink-0">
              <div className="flex items-center justify-between">
                <button
                  onClick={() => onJoyConPress('POWER')}
                  title="Power Button"
                  className="w-5 h-5 rounded-full bg-slate-900/20 hover:bg-slate-900/35 flex items-center justify-center cursor-pointer"
                >
                  <Power className="w-3 h-3" />
                </button>
                <div className="w-4 h-1 rounded-full bg-slate-900/60" />
              </div>

              {/* Left Thumbstick */}
              <div className="flex justify-center">
                <div className="w-12 h-12 rounded-full bg-[#242830] border-4 border-[#17191F] shadow-inner flex items-center justify-center">
                  <div className="w-7 h-7 rounded-full bg-[#2F343E]" />
                </div>
              </div>

              {/* D-Pad Buttons */}
              <div className="grid grid-cols-3 gap-1.5 w-20 mx-auto">
                <div />
                <button
                  onClick={() => onJoyConPress('UP')}
                  className="w-6 h-6 rounded-full bg-[#22262E] hover:bg-[#343A46] text-white text-[10px] font-bold flex items-center justify-center cursor-pointer active:scale-95"
                  aria-label="D-Pad Up"
                >
                  ▲
                </button>
                <div />
                <button
                  onClick={() => onJoyConPress('LEFT')}
                  className="w-6 h-6 rounded-full bg-[#22262E] hover:bg-[#343A46] text-white text-[10px] font-bold flex items-center justify-center cursor-pointer active:scale-95"
                  aria-label="D-Pad Left"
                >
                  ◀
                </button>
                <div />
                <button
                  onClick={() => onJoyConPress('RIGHT')}
                  className="w-6 h-6 rounded-full bg-[#22262E] hover:bg-[#343A46] text-white text-[10px] font-bold flex items-center justify-center cursor-pointer active:scale-95"
                  aria-label="D-Pad Right"
                >
                  ▶
                </button>
                <div />
                <button
                  onClick={() => onJoyConPress('DOWN')}
                  className="w-6 h-6 rounded-full bg-[#22262E] hover:bg-[#343A46] text-white text-[10px] font-bold flex items-center justify-center cursor-pointer active:scale-95"
                  aria-label="D-Pad Down"
                >
                  ▼
                </button>
                <div />
              </div>

              <div className="flex justify-end pr-2">
                <div className="w-5 h-5 rounded-sm bg-[#22262E] border border-slate-700" />
              </div>
            </div>

            {/* Center Tablet Bezel + 16:9 Screen */}
            <div className="flex-1 max-w-[940px] bg-[#181B20] p-3 sm:p-4 border-y-2 border-slate-800 rounded-xl md:rounded-none shadow-2xl">
              <div className="w-full aspect-video rounded-md overflow-hidden border border-slate-900 bg-black relative">
                <div
                  className="w-full h-full transition-[filter] duration-150"
                  style={{ filter: `brightness(${brightness}%)` }}
                >
                  {children}
                </div>
              </div>
            </div>

            {/* Right Neon Red Joy-Con */}
            <div className="hidden md:flex w-28 lg:w-32 bg-[#FF4554] rounded-r-[3rem] border-y-2 border-r-2 border-[#D82E3D] p-3.5 flex-col justify-between text-white shadow-xl shrink-0">
              <div className="flex items-center justify-between">
                <button
                  onClick={() => onJoyConPress('PLUS')}
                  className="w-6 h-6 rounded-full hover:bg-black/15 flex items-center justify-center font-bold text-base text-slate-950 cursor-pointer"
                  title="+ Options"
                >
                  +
                </button>
              </div>

              {/* ABXY Face Buttons */}
              <div className="grid grid-cols-3 gap-1.5 w-20 mx-auto">
                <div />
                <button
                  onClick={() => onJoyConPress('X')}
                  className="w-6 h-6 rounded-full bg-[#22262E] hover:bg-[#343A46] text-white text-[11px] font-bold flex items-center justify-center cursor-pointer active:scale-95"
                >
                  X
                </button>
                <div />
                <button
                  onClick={() => onJoyConPress('Y')}
                  className="w-6 h-6 rounded-full bg-[#22262E] hover:bg-[#343A46] text-white text-[11px] font-bold flex items-center justify-center cursor-pointer active:scale-95"
                >
                  Y
                </button>
                <div />
                <button
                  onClick={() => onJoyConPress('A')}
                  className="w-6 h-6 rounded-full bg-[#22262E] hover:bg-[#343A46] text-white text-[11px] font-bold flex items-center justify-center cursor-pointer active:scale-95"
                >
                  A
                </button>
                <div />
                <button
                  onClick={() => onJoyConPress('B')}
                  className="w-6 h-6 rounded-full bg-[#22262E] hover:bg-[#343A46] text-white text-[11px] font-bold flex items-center justify-center cursor-pointer active:scale-95"
                >
                  B
                </button>
                <div />
              </div>

              {/* Right Thumbstick */}
              <div className="flex justify-center">
                <div className="w-12 h-12 rounded-full bg-[#242830] border-4 border-[#17191F] shadow-inner flex items-center justify-center">
                  <div className="w-7 h-7 rounded-full bg-[#2F343E]" />
                </div>
              </div>

              <div className="flex justify-start pl-2">
                <button
                  onClick={() => onJoyConPress('HOME')}
                  title="HOME Button"
                  className="w-6 h-6 rounded-full bg-[#22262E] border-2 border-slate-400 hover:border-white flex items-center justify-center text-[9px] font-bold cursor-pointer active:scale-95"
                >
                  ⌂
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Collapsible Live IndexedDB NAND Bus Telemetry Drawer */}
        {showBusMonitor && (
          <div className="w-full max-w-[1160px] rounded-xl border border-slate-800 bg-[#14171E] p-4">
            <div className="flex items-center justify-between pb-2.5 border-b border-slate-800">
              <div className="text-xs font-display font-bold text-slate-200">
                IndexedDB eMMC Chunk I/O Bus (nx_nand_emmc_v1 · 16 KiB Uint8Array blocks)
              </div>
              <span className="text-[11px] font-mono-tabular text-slate-400">
                {ioEvents.length} recent operations
              </span>
            </div>
            <div className="mt-2.5 max-h-40 overflow-y-auto thin-scrollbar space-y-1 font-mono-tabular text-xs">
              {ioEvents.map((ev) => (
                <div
                  key={ev.id}
                  className="flex items-center justify-between gap-4 py-1 border-b border-slate-800/50 last:border-0"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${
                        ev.op === 'CORRUPT'
                          ? 'bg-red-950 text-red-300'
                          : ev.op === 'WRITE' || ev.op === 'FLASH'
                            ? 'bg-amber-950 text-amber-300'
                            : 'bg-sky-950 text-sky-300'
                      }`}
                    >
                      {ev.op}
                    </span>
                    <span className="font-bold text-white shrink-0">{ev.partitionId}</span>
                    <span className="text-slate-400 shrink-0">[{ev.chunkRange}]</span>
                    <span className="text-slate-300 truncate">{ev.detail}</span>
                  </div>
                  <span
                    className={`shrink-0 text-[11px] ${
                      ev.crcOk ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {ev.crcOk ? 'CRC OK' : 'FAULT'}
                  </span>
                </div>
              ))}
              {ioEvents.length === 0 && (
                <div className="text-slate-500 text-xs py-2">
                  Waiting for NAND I/O operations…
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
