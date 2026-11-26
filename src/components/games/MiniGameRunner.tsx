import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Cpu,
  Disc,
  Play,
  RotateCcw,
  ShieldCheck,
  Trophy,
  Wrench,
  XCircle,
} from 'lucide-react';
import { switchAudio } from '../../audio/switchAudio';
import { crc32, formatHex32, formatHexDump, sha256HexSync } from '../../nand/crc32';
import { nandStore } from '../../nand/nandChunkStore';
import { reassembleChunks, unpackNxfs } from '../../nand/nandFs';
import {
  AlbumCapture,
  BootedSystemContext,
  ChromaticPadDef,
  InstalledTitle,
  NandAuditReport,
  NandChunkRecord,
  NandPartitionMeta,
  NxfsFileEntry,
  PartitionId,
  QuizPackage,
  SpriteBitmap,
  StellarGameConfig,
  SwitchThemeTokens,
  TetrominoGameConfig,
} from '../../nand/nandTypes';

function bitmapToOffscreenCanvas(bmp?: SpriteBitmap): HTMLCanvasElement | null {
  if (!bmp || typeof document === 'undefined') return null;
  const off = document.createElement('canvas');
  off.width = bmp.width;
  off.height = bmp.height;
  const octx = off.getContext('2d');
  if (!octx) return null;
  const imgData = octx.createImageData(bmp.width, bmp.height);
  imgData.data.set(bmp.rgba);
  octx.putImageData(imgData, 0, 0);
  return off;
}

interface MiniGameRunnerProps {
  title: InstalledTitle;
  system: BootedSystemContext;
  theme: SwitchThemeTokens;
  onSaveScore: (titleId: string, score: number, extraMinutes?: number) => Promise<void>;
  onSaveCapture: (capture: AlbumCapture) => Promise<void>;
  onExit: () => void;
}

export const MiniGameRunner: React.FC<MiniGameRunnerProps> = ({
  title,
  system,
  theme,
  onSaveScore,
  onSaveCapture,
  onExit,
}) => {
  return (
    <div className="w-full h-full bg-[#0E1117] text-slate-100 flex flex-col select-none">
      {/* Running Software Header */}
      <div className="flex items-center justify-between px-5 py-2.5 bg-[#151A24] border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-3">
          <span className="px-2 py-0.5 rounded bg-[#E60012] text-white text-[10px] font-bold tracking-wide">
            RUNNING
          </span>
          <span className="font-display font-bold text-sm">{title.title}</span>
          {title.highScore !== undefined && (
            <span className="text-xs font-mono-tabular text-amber-300 flex items-center gap-1">
              <Trophy className="w-3.5 h-3.5" />
              Best: {title.highScore}
            </span>
          )}
        </div>
        <button
          onClick={() => {
            switchAudio.play('back');
            onExit();
          }}
          className="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs font-semibold border border-slate-700 cursor-pointer"
        >
          HOME · Suspend & Exit
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {title.runnerType === 'stellar' && (
          <StellarGame
            title={title}
            config={system.stellarConfig}
            sprites={system.spriteAtlas}
            onSaveScore={onSaveScore}
          />
        )}
        {title.runnerType === 'blocks' && (
          <BlockStackGame
            title={title}
            config={system.tetrominoConfig}
            onSaveScore={onSaveScore}
          />
        )}
        {title.runnerType === 'chromatic' && (
          <ChromaticGame
            title={title}
            pads={system.chromaticPads}
            onSaveScore={onSaveScore}
          />
        )}
        {title.runnerType === 'hex' && <NandHexInspectorApp theme={theme} />}
        {title.runnerType === 'sketch' && (
          <TactileSketchpad title={title} onSaveCapture={onSaveCapture} />
        )}
        {title.runnerType === 'cartridge' && <VirtualCartridgeApp />}
        {title.runnerType === 'trivia' && (
          <ArchitectureQuizGame
            title={title}
            quizPackage={system.quizPackage}
            onSaveScore={onSaveScore}
          />
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 1. STELLAR ODYSSEY (Canvas Shooter driven by SYSTEM STLR + SPR0 RGBA8888)
// ============================================================================
const StellarGame: React.FC<{
  title: InstalledTitle;
  config: StellarGameConfig;
  sprites: Record<string, SpriteBitmap>;
  onSaveScore: (id: string, score: number) => Promise<void>;
}> = ({ title, config, sprites, onSaveScore }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [score, setScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [runId, setRunId] = useState(1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const shipBmpCanvas = bitmapToOffscreenCanvas(sprites.ship);
    const asteroidBmpCanvas = bitmapToOffscreenCanvas(sprites.asteroid);

    let animId = 0;
    let shipX = 320;
    const shipY = 300;
    let currentScore = 0;
    let ended = false;
    const keys: Record<string, boolean> = {};
    const bullets: { x: number; y: number }[] = [];
    const rocks: { x: number; y: number; r: number; vy: number }[] = [];
    let tick = 0;

    const onKeyDown = (e: KeyboardEvent) => {
      keys[e.key] = true;
      if ((e.key === ' ' || e.key === 'Enter') && !ended) {
        bullets.push({ x: shipX, y: shipY - 14 });
        switchAudio.play('tick');
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys[e.key] = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const loop = () => {
      tick++;
      if (keys['ArrowLeft'] || keys['a']) shipX = Math.max(24, shipX - config.shipSpeed);
      if (keys['ArrowRight'] || keys['d']) shipX = Math.min(616, shipX + config.shipSpeed);

      if (tick % Math.max(4, config.fireIntervalTicks) === 0 && !ended) {
        bullets.push({ x: shipX, y: shipY - 16 });
      }
      if (tick % Math.max(6, config.spawnIntervalTicks) === 0 && !ended) {
        rocks.push({
          x: 24 + Math.random() * 592,
          y: -20,
          r: 14 + Math.random() * 14,
          vy: 2.1 + Math.min(3.5, currentScore / 600),
        });
      }

      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = config.bgColor;
      ctx.fillRect(0, 0, 640, 340);

      // Starfield
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      for (let i = 0; i < 24; i++) {
        const sx = (i * 97 + tick * 0.3) % 640;
        const sy = (i * 53 + tick * 1.4) % 340;
        ctx.fillRect(sx, sy, 2, 2);
      }

      // Update & draw bullets
      ctx.fillStyle = config.bulletColor;
      for (let i = bullets.length - 1; i >= 0; i--) {
        bullets[i].y -= config.bulletSpeed;
        ctx.fillRect(bullets[i].x - 2, bullets[i].y - 8, 4, 12);
        if (bullets[i].y < -15) bullets.splice(i, 1);
      }

      // Update & draw rocks using SPR0 asteroid bitmap
      for (let i = rocks.length - 1; i >= 0; i--) {
        const r = rocks[i];
        r.y += r.vy;
        if (asteroidBmpCanvas) {
          const size = r.r * 2.1;
          ctx.drawImage(asteroidBmpCanvas, r.x - size / 2, r.y - size / 2, size, size);
        } else {
          ctx.beginPath();
          ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
          ctx.fillStyle = '#E11D48';
          ctx.fill();
        }

        // Hit bullet
        let hit = false;
        for (let b = bullets.length - 1; b >= 0; b--) {
          const dx = bullets[b].x - r.x;
          const dy = bullets[b].y - r.y;
          if (dx * dx + dy * dy < r.r * r.r) {
            bullets.splice(b, 1);
            rocks.splice(i, 1);
            currentScore += config.pointsPerRock;
            setScore(currentScore);
            switchAudio.play('select');
            hit = true;
            break;
          }
        }
        if (hit) continue;

        // Ship collision
        const sdx = shipX - r.x;
        const sdy = shipY - r.y;
        if (sdx * sdx + sdy * sdy < (r.r + 13) * (r.r + 13)) {
          ended = true;
          setGameOver(true);
          switchAudio.play('error');
          onSaveScore(title.id, currentScore);
        }

        if (r.y > 365) rocks.splice(i, 1);
      }

      // Draw ship using SPR0 RGBA8888 bitmap
      if (shipBmpCanvas) {
        ctx.drawImage(shipBmpCanvas, shipX - 18, shipY - 18, 36, 36);
      } else {
        ctx.fillStyle = '#F8FAFC';
        ctx.beginPath();
        ctx.moveTo(shipX, shipY - 16);
        ctx.lineTo(shipX + 14, shipY + 12);
        ctx.lineTo(shipX, shipY + 6);
        ctx.lineTo(shipX - 14, shipY + 12);
        ctx.closePath();
        ctx.fill();
      }

      if (!ended) {
        animId = requestAnimationFrame(loop);
      }
    };

    animId = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [runId, title.id, config, sprites, onSaveScore]);

  return (
    <div className="w-full h-full flex flex-col items-center justify-center p-4 gap-3 bg-[#060912]">
      <div className="flex items-center justify-between w-full max-w-[640px] text-xs font-mono-tabular">
        <span>
          Arrow / A-D · SPR0 RGBA8888 ({sprites.ship?.width ?? 16}×{sprites.ship?.height ?? 16}) · STLR (+{config.pointsPerRock}/rock)
        </span>
        <span className="text-[#38BDF8] font-bold">SCORE: {score}</span>
      </div>
      <div className="relative rounded-lg overflow-hidden border border-slate-800">
        <canvas ref={canvasRef} width={640} height={340} className="block max-w-full" />
        {gameOver && (
          <div className="absolute inset-0 bg-black/75 flex flex-col items-center justify-center gap-3">
            <div className="font-display text-2xl font-bold text-white">Mission Complete</div>
            <div className="text-sm font-mono-tabular text-amber-300">
              Final Score: {score} (Saved to USER NAND)
            </div>
            <button
              onClick={() => {
                setScore(0);
                setGameOver(false);
                setRunId((n) => n + 1);
              }}
              className="px-4 py-2 rounded-md bg-[#0AB9E6] text-slate-950 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Play Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 2. BLOCK STACK DX (Grid Puzzle driven by SYSTEM TET0)
// ============================================================================
const COLS = 10;
const ROWS = 14;

const BlockStackGame: React.FC<{
  title: InstalledTitle;
  config: TetrominoGameConfig;
  onSaveScore: (id: string, score: number) => Promise<void>;
}> = ({ title, config, onSaveScore }) => {
  const shapes = config.shapes;
  const [grid, setGrid] = useState<(string | null)[][]>(() =>
    Array.from({ length: ROWS }, () => Array(COLS).fill(null))
  );
  const [piece, setPiece] = useState(() => ({
    x: 3,
    y: 0,
    shape: shapes[0],
  }));
  const [score, setScore] = useState(0);
  const [over, setOver] = useState(false);

  const collides = useCallback(
    (nx: number, ny: number, cells: number[][], g: (string | null)[][]) => {
      for (let r = 0; r < cells.length; r++) {
        for (let c = 0; c < cells[r].length; c++) {
          if (!cells[r][c]) continue;
          const gx = nx + c;
          const gy = ny + r;
          if (gx < 0 || gx >= COLS || gy >= ROWS) return true;
          if (gy >= 0 && g[gy][gx]) return true;
        }
      }
      return false;
    },
    []
  );

  const stepDown = useCallback(() => {
    if (over) return;
    setPiece((prev) => {
      if (!collides(prev.x, prev.y + 1, prev.shape.cells, grid)) {
        return { ...prev, y: prev.y + 1 };
      }
      // Lock piece
      const nextGrid = grid.map((row) => [...row]);
      prev.shape.cells.forEach((row, r) =>
        row.forEach((v, c) => {
          if (v && prev.y + r >= 0 && prev.y + r < ROWS) {
            nextGrid[prev.y + r][prev.x + c] = prev.shape.color;
          }
        })
      );
      // Clear full lines
      const kept = nextGrid.filter((row) => row.some((cell) => cell === null));
      const cleared = ROWS - kept.length;
      while (kept.length < ROWS) kept.unshift(Array(COLS).fill(null));
      const newScore = score + config.lockBonus + cleared * config.lineScore;
      if (cleared > 0) switchAudio.play('select');
      setGrid(kept);
      setScore(newScore);

      const nextShape = shapes[Math.floor(Math.random() * shapes.length)];
      if (collides(3, 0, nextShape.cells, kept)) {
        setOver(true);
        switchAudio.play('error');
        onSaveScore(title.id, newScore);
        return prev;
      }
      return { x: 3, y: 0, shape: nextShape };
    });
  }, [collides, config.lineScore, config.lockBonus, grid, onSaveScore, over, score, shapes, title.id]);

  useEffect(() => {
    const id = setInterval(stepDown, config.dropIntervalMs);
    return () => clearInterval(id);
  }, [config.dropIntervalMs, stepDown]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (over) return;
      if (e.key === 'ArrowLeft') {
        setPiece((p) =>
          collides(p.x - 1, p.y, p.shape.cells, grid) ? p : { ...p, x: p.x - 1 }
        );
      } else if (e.key === 'ArrowRight') {
        setPiece((p) =>
          collides(p.x + 1, p.y, p.shape.cells, grid) ? p : { ...p, x: p.x + 1 }
        );
      } else if (e.key === 'ArrowDown') {
        stepDown();
      } else if (e.key === 'ArrowUp' || e.key === ' ') {
        setPiece((p) => {
          const rot = p.shape.cells[0].map((_, idx) =>
            p.shape.cells.map((row) => row[idx]).reverse()
          );
          if (collides(p.x, p.y, rot, grid)) return p;
          switchAudio.play('tick');
          return { ...p, shape: { ...p.shape, cells: rot } };
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collides, grid, over, stepDown]);

  const restart = () => {
    setGrid(Array.from({ length: ROWS }, () => Array(COLS).fill(null)));
    setPiece({ x: 3, y: 0, shape: shapes[0] });
    setScore(0);
    setOver(false);
  };

  return (
    <div className="w-full h-full flex items-center justify-center gap-8 p-4 bg-[#11141C]">
      <div className="grid grid-cols-10 gap-0.5 p-2 bg-[#090B10] border border-slate-700 rounded-md">
        {grid.map((row, r) =>
          row.map((cell, c) => {
            let activeColor = cell;
            const pr = r - piece.y;
            const pc = c - piece.x;
            if (
              !over &&
              pr >= 0 &&
              pr < piece.shape.cells.length &&
              pc >= 0 &&
              pc < piece.shape.cells[0].length &&
              piece.shape.cells[pr][pc]
            ) {
              activeColor = piece.shape.color;
            }
            return (
              <div
                key={`${r}-${c}`}
                className="w-5 h-5 rounded-[2px]"
                style={{
                  backgroundColor: activeColor ?? '#161B26',
                }}
              />
            );
          })
        )}
      </div>

      <div className="space-y-4 w-56">
        <div className="p-4 rounded-lg bg-[#161B26] border border-slate-800">
          <div className="text-xs text-slate-400">Current Score</div>
          <div className="font-mono-tabular text-2xl font-bold text-[#0AB9E6]">{score}</div>
          <div className="text-[10px] font-mono-tabular text-slate-500 mt-1">
            TET0: {shapes.length} shapes · {config.dropIntervalMs}ms tick
          </div>
        </div>
        <div className="text-xs text-slate-400 space-y-1">
          <div>Left / Right: Move</div>
          <div>Up / Space: Rotate</div>
          <div>Down: Drop</div>
        </div>
        {over && (
          <div className="p-3 rounded-lg bg-red-950/50 border border-red-800 space-y-2">
            <div className="text-xs font-bold text-red-200">Stack Overflow · Saved</div>
            <button
              onClick={restart}
              className="w-full py-1.5 rounded bg-[#0AB9E6] text-slate-950 text-xs font-bold cursor-pointer"
            >
              Restart
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 3. CHROMATIC DRIFT (Audio-Visual Memory driven by SYSTEM CHR0)
// ============================================================================
const ChromaticGame: React.FC<{
  title: InstalledTitle;
  pads: ChromaticPadDef[];
  onSaveScore: (id: string, score: number) => Promise<void>;
}> = ({ title, pads, onSaveScore }) => {
  const [sequence, setSequence] = useState<number[]>([]);
  const [stepIdx, setStepIdx] = useState(0);
  const [litPad, setLitPad] = useState<number | null>(null);
  const [status, setStatus] = useState<'IDLE' | 'SHOWING' | 'INPUT' | 'FAIL'>('IDLE');

  const playPadTone = (padId: number) => {
    const def = pads.find((p) => p.id === padId) ?? pads[padId];
    if (def) {
      switchAudio.playTone(def.freqHz, def.durationMs, 'triangle', 0.09);
    } else {
      switchAudio.play('select');
    }
  };

  const playSequence = async (seq: number[]) => {
    setStatus('SHOWING');
    for (const pad of seq) {
      await new Promise((r) => setTimeout(r, 240));
      setLitPad(pad);
      playPadTone(pad);
      await new Promise((r) => setTimeout(r, 340));
      setLitPad(null);
    }
    setStepIdx(0);
    setStatus('INPUT');
  };

  const startRound = () => {
    const next = [Math.floor(Math.random() * pads.length)];
    setSequence(next);
    playSequence(next);
  };

  const handlePad = async (id: number) => {
    if (status !== 'INPUT') return;
    setLitPad(id);
    playPadTone(id);
    setTimeout(() => setLitPad(null), 160);

    if (sequence[stepIdx] !== id) {
      setStatus('FAIL');
      switchAudio.play('error');
      await onSaveScore(title.id, Math.max(0, sequence.length - 1));
      return;
    }

    if (stepIdx + 1 >= sequence.length) {
      const nextSeq = [...sequence, Math.floor(Math.random() * pads.length)];
      setSequence(nextSeq);
      setTimeout(() => playSequence(nextSeq), 420);
    } else {
      setStepIdx((s) => s + 1);
    }
  };

  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-6 bg-[#101320] p-6">
      <div className="text-center">
        <div className="font-display font-bold text-lg">
          Streak: {status === 'IDLE' ? 0 : Math.max(0, sequence.length - 1)}
        </div>
        <div className="text-xs text-slate-400 mt-1">
          {status === 'IDLE' && 'Press Start to watch and repeat the CHR0 harmonic sequence'}
          {status === 'SHOWING' && 'Watch & listen carefully…'}
          {status === 'INPUT' && `Repeat step ${stepIdx + 1} of ${sequence.length}`}
          {status === 'FAIL' && 'Sequence missed! Best streak saved to USER NAND.'}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {pads.map((p) => (
          <button
            key={p.id}
            onClick={() => handlePad(p.id)}
            className={`w-36 h-28 rounded-xl font-display font-bold text-white transition-transform cursor-pointer flex flex-col items-center justify-center ${
              litPad === p.id ? 'scale-105 brightness-125 ring-4 ring-white' : 'opacity-80 hover:opacity-100'
            }`}
            style={{ backgroundColor: p.color }}
          >
            <span>{p.label}</span>
            <span className="text-[10px] font-mono-tabular opacity-80">{p.freqHz} Hz</span>
          </button>
        ))}
      </div>

      {(status === 'IDLE' || status === 'FAIL') && (
        <button
          onClick={startRound}
          className="px-5 py-2 rounded-md bg-[#0AB9E6] text-slate-950 text-xs font-bold flex items-center gap-2 cursor-pointer"
        >
          <Play className="w-3.5 h-3.5 fill-current" />
          {status === 'FAIL' ? 'Retry Sequence' : 'Start Sequence'}
        </button>
      )}
    </div>
  );
};

// ============================================================================
// 4. NAND HEX & PARTITION INSPECTOR (Live IDB Inspection + Fault Injection)
// ============================================================================
const NandHexInspectorApp: React.FC<{ theme: SwitchThemeTokens }> = () => {
  const [partitions, setPartitions] = useState<NandPartitionMeta[]>([]);
  const [selectedPart, setSelectedPart] = useState<PartitionId>('SYSTEM');
  const [chunks, setChunks] = useState<NandChunkRecord[]>([]);
  const [chunkIdx, setChunkIdx] = useState(0);
  const [files, setFiles] = useState<NxfsFileEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [auditReport, setAuditReport] = useState<NandAuditReport | null>(null);
  const [showAudit, setShowAudit] = useState(false);

  const refresh = async (pid: PartitionId = selectedPart, refreshAudit = false) => {
    const parts = await nandStore.listPartitions();
    setPartitions(parts);
    const recs = await nandStore.getPartitionChunkRecords(pid);
    setChunks(recs);
    setChunkIdx(0);
    try {
      const res = await nandStore.readPartitionImage(pid);
      const unpacked = unpackNxfs(res.image);
      setFiles(unpacked.entries);
    } catch {
      setFiles([]);
    }
    if (refreshAudit || showAudit) {
      setAuditReport(await nandStore.auditNandConsistency());
    }
  };

  useEffect(() => {
    refresh('SYSTEM', true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runAudit = async () => {
    const report = await nandStore.auditNandConsistency();
    setAuditReport(report);
    setShowAudit(true);
    setNotice(
      report.allPassed
        ? `Full NAND Audit Passed (${report.passedCount}/${report.totalCount} checks).`
        : `NAND Audit Failed: ${report.passedCount}/${report.totalCount} checks passed.`
    );
  };

  const activeMeta = partitions.find((p) => p.id === selectedPart);
  const activeChunk = chunks[chunkIdx];
  const hexLines = activeChunk ? formatHexDump(activeChunk.data, 14) : [];
  const livePartSha =
    activeMeta && chunks.length === activeMeta.chunkCount && chunks.length > 0
      ? sha256HexSync(reassembleChunks(chunks.map((c) => c.data)))
      : null;
  const partShaOk = activeMeta ? livePartSha === activeMeta.sha256 : false;

  return (
    <div className="w-full h-full grid grid-cols-12 bg-[#0B0E14] text-slate-100">
      <div className="col-span-4 border-r border-slate-800 p-3 overflow-y-auto thin-scrollbar space-y-1.5">
        <div className="text-[11px] font-medium text-slate-400 px-1 pb-1">
          IndexedDB GPT Partitions (nx_nand_emmc_v1)
        </div>
        {partitions.map((p) => (
          <button
            key={p.id}
            onClick={() => {
              switchAudio.play('tick');
              setSelectedPart(p.id);
              refresh(p.id);
            }}
            className={`w-full text-left p-2.5 rounded border cursor-pointer ${
              selectedPart === p.id
                ? 'bg-[#162233] border-[#0AB9E6]'
                : 'bg-[#11151E] border-slate-800'
            }`}
          >
            <div className="flex items-center justify-between text-xs font-mono-tabular font-bold">
              <span>{p.id}</span>
              <span className="text-slate-400">
                {p.chunkCount} chunks · {p.encrypted ? 'ENC' : 'RAW'}
              </span>
            </div>
            <div className="text-[11px] text-slate-400 truncate mt-0.5">{p.description}</div>
          </button>
        ))}
      </div>

      <div className="col-span-8 p-4 flex flex-col min-h-0 overflow-y-auto thin-scrollbar gap-3">
        <div className="flex flex-wrap items-center justify-between border-b border-slate-800 pb-2.5 gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[#0AB9E6] shrink-0" />
              <span className="font-mono-tabular text-xs font-bold">
                {selectedPart} · {chunks.length} Uint8Array Chunks
              </span>
            </div>
            {activeMeta && (
              <div
                className={`text-[10px] font-mono-tabular mt-0.5 ${
                  partShaOk ? 'text-emerald-400' : 'text-red-400 font-bold'
                }`}
              >
                SHA-256 {activeMeta.sha256.slice(0, 20)}… ({partShaOk ? 'Verified' : 'Mismatch'})
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => (showAudit ? setShowAudit(false) : runAudit())}
              className={`px-2.5 py-1 rounded border text-[11px] font-medium flex items-center gap-1 cursor-pointer ${
                auditReport && !auditReport.allPassed
                  ? 'bg-red-950 border-red-700 text-red-200'
                  : 'bg-slate-800 border-slate-700 text-slate-200'
              }`}
            >
              <ShieldCheck className="w-3 h-3 text-emerald-400" />
              {auditReport ? `Audit ${auditReport.passedCount}/${auditReport.totalCount}` : 'Verify All'}
            </button>
            <button
              onClick={async () => {
                await nandStore.corruptChunk(selectedPart, chunkIdx);
                await refresh(selectedPart, true);
                setNotice(
                  `Corrupted ${selectedPart} chunk #${chunkIdx}. Run Audit or Reboot to catch the CRC32/SHA-256 fault.`
                );
              }}
              disabled={chunks.length === 0}
              className="px-2.5 py-1 rounded bg-amber-950 border border-amber-700 text-amber-200 text-[11px] font-medium flex items-center gap-1 cursor-pointer"
            >
              <AlertTriangle className="w-3 h-3" />
              Inject Bit-Rot
            </button>
            <button
              onClick={async () => {
                await nandStore.repairPartition(selectedPart);
                await refresh(selectedPart, true);
                setNotice(`Repaired ${selectedPart} from factory image.`);
              }}
              className="px-2.5 py-1 rounded bg-emerald-950 border border-emerald-700 text-emerald-200 text-[11px] font-medium flex items-center gap-1 cursor-pointer"
            >
              <Wrench className="w-3 h-3" />
              Repair
            </button>
          </div>
        </div>

        {notice && (
          <div className="px-3 py-1.5 rounded bg-sky-950/70 border border-sky-800 text-xs text-sky-200">
            {notice}
          </div>
        )}

        {showAudit && auditReport && (
          <div className="p-2.5 rounded bg-[#080B10] border border-slate-800 space-y-1 max-h-40 overflow-y-auto thin-scrollbar">
            <div className="flex items-center justify-between text-[11px] font-mono-tabular text-slate-300 pb-1">
              <span>
                Cross-Partition Cryptographic Audit ({auditReport.passedCount}/{auditReport.totalCount})
              </span>
              <button
                onClick={runAudit}
                className="text-[#0AB9E6] hover:underline cursor-pointer"
              >
                Re-verify
              </button>
            </div>
            {auditReport.checks.map((chk) => (
              <div
                key={chk.id}
                className={`px-2 py-1 rounded text-[11px] flex items-center gap-2 ${
                  chk.passed ? 'text-emerald-200' : 'bg-red-950/50 text-red-200'
                }`}
              >
                {chk.passed ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                )}
                <span className="font-semibold shrink-0">[{chk.category}]</span>
                <span className="truncate text-slate-300">{chk.detail}</span>
              </div>
            ))}
          </div>
        )}

        {/* Files inside NXFS */}
        <div>
          <div className="text-[11px] text-slate-400 mb-1">
            NXFS Filesystem Entries ({files.length})
          </div>
          <div className="grid grid-cols-2 gap-1.5 max-h-24 overflow-y-auto thin-scrollbar">
            {files.map((f) => (
              <div
                key={f.path}
                className="px-2.5 py-1 rounded bg-[#121722] border border-slate-800 text-[11px] font-mono-tabular flex justify-between"
              >
                <span className="truncate text-slate-200">{f.path}</span>
                <span className="text-slate-400 ml-2 shrink-0">{f.length}B</span>
              </div>
            ))}
          </div>
        </div>

        {/* Chunk tabs + hex dump */}
        <div className="flex flex-wrap gap-1.5">
          {chunks.map((c) => {
            const crcOk = crc32(c.data) === c.crc32 && c.data.length === c.byteLength;
            return (
              <button
                key={c.key}
                onClick={() => setChunkIdx(c.chunkIndex)}
                className={`px-2 py-1 rounded text-[11px] font-mono-tabular border cursor-pointer ${
                  c.chunkIndex === chunkIdx
                    ? crcOk
                      ? 'bg-[#0AB9E6] text-slate-950 border-[#0AB9E6] font-bold'
                      : 'bg-red-500 text-white border-red-400 font-bold'
                    : crcOk
                      ? 'bg-[#121722] text-slate-300 border-slate-800'
                      : 'bg-red-950/70 text-red-300 border-red-700'
                }`}
              >
                #{c.chunkIndex} ({c.byteLength}B · {formatHex32(c.crc32)}
                {crcOk ? '' : ' · BAD CRC'})
              </button>
            );
          })}
        </div>

        {activeChunk && (
          <pre className="flex-1 bg-[#06080B] border border-slate-800 rounded p-3 font-mono-tabular text-[11px] text-emerald-300 overflow-auto thin-scrollbar">
            {hexLines.join('\n')}
          </pre>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 5. TACTILE SKETCHPAD (Saves PNG artwork directly to USER NAND Album)
// ============================================================================
const TactileSketchpad: React.FC<{
  title: InstalledTitle;
  onSaveCapture: (cap: AlbumCapture) => Promise<void>;
}> = ({ title, onSaveCapture }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [color, setColor] = useState('#E60012');
  const [savedMsg, setSavedMsg] = useState(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, c.width, c.height);
  }, []);

  const drawAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const rect = c.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * c.width;
    const y = ((e.clientY - rect.top) / rect.height) * c.height;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  };

  const handleExportToNand = async () => {
    const c = canvasRef.current;
    if (!c) return;
    const dataUrl = c.toDataURL('image/png');
    await onSaveCapture({
      id: `cap-${Date.now()}`,
      title: `Sketchpad Capture ${new Date().toLocaleTimeString()}`,
      gameTitle: title.title,
      capturedAt: Date.now(),
      dataUrl,
    });
    switchAudio.play('click');
    setSavedMsg(true);
    setTimeout(() => setSavedMsg(false), 2000);
  };

  return (
    <div className="w-full h-full flex flex-col items-center justify-center p-4 gap-3 bg-[#151821]">
      <div className="flex items-center justify-between w-full max-w-[560px]">
        <div className="flex items-center gap-2">
          {['#E60012', '#0AB9E6', '#10B981', '#F59E0B', '#1E293B'].map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`w-6 h-6 rounded-full cursor-pointer border-2 ${
                color === c ? 'border-white scale-110' : 'border-transparent'
              }`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const c = canvasRef.current;
              const ctx = c?.getContext('2d');
              if (c && ctx) {
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, c.width, c.height);
              }
            }}
            className="px-3 py-1 rounded bg-slate-800 text-xs font-medium cursor-pointer"
          >
            Clear
          </button>
          <button
            onClick={handleExportToNand}
            className="px-3 py-1 rounded bg-[#0AB9E6] text-slate-950 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
          >
            <Camera className="w-3.5 h-3.5" />
            {savedMsg ? 'Saved to NAND Album!' : 'Save to NAND Album'}
          </button>
        </div>
      </div>

      <canvas
        ref={canvasRef}
        width={560}
        height={300}
        onPointerDown={(e) => {
          drawing.current = true;
          drawAt(e);
        }}
        onPointerMove={drawAt}
        onPointerUp={() => (drawing.current = false)}
        onPointerLeave={() => (drawing.current = false)}
        className="rounded-lg border border-slate-700 cursor-crosshair bg-white max-w-full"
      />
    </div>
  );
};

// ============================================================================
// 6. VIRTUAL CARTRIDGE SLOT
// ============================================================================
const VirtualCartridgeApp: React.FC = () => {
  const [inserted, setInserted] = useState(true);
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-5 bg-[#12161E] p-6 text-center">
      <Disc className={`w-16 h-16 ${inserted ? 'text-[#E60012]' : 'text-slate-600'}`} />
      <div>
        <h2 className="font-display font-bold text-lg">
          {inserted ? 'Game Card Mounted: Stellar Odyssey (HAC-P-ASTR)' : 'Game Card Slot Empty'}
        </h2>
        <p className="text-xs text-slate-400 mt-1 max-w-md">
          Simulates the physical cartridge slot bridge on Slot 0. Ejecting or inserting updates console hardware state.
        </p>
      </div>
      <button
        onClick={() => {
          switchAudio.play('click');
          setInserted((v) => !v);
        }}
        className="px-4 py-2 rounded-md bg-[#0AB9E6] text-slate-950 text-xs font-bold cursor-pointer"
      >
        {inserted ? 'Eject Game Card' : 'Insert Stellar Odyssey Card'}
      </button>
    </div>
  );
};

// ============================================================================
// 7. CONSOLE ARCHITECTURE QUIZ (Loaded from USER /user/apps/title-trivia.pkg)
// ============================================================================
const ArchitectureQuizGame: React.FC<{
  title: InstalledTitle;
  quizPackage: QuizPackage | null;
  onSaveScore: (id: string, score: number) => Promise<void>;
}> = ({ title, quizPackage, onSaveScore }) => {
  const [idx, setIdx] = useState(0);
  const [score, setScore] = useState(0);
  const [done, setDone] = useState(false);

  if (!quizPackage || quizPackage.questions.length === 0) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-[#0D1418] p-6 text-center">
        <div className="font-display text-lg font-bold text-red-400">
          Missing Binary Package (USER:/user/apps/title-trivia.pkg)
        </div>
        <div className="text-xs text-slate-400 max-w-md">
          Re-install Console Architecture Quiz from Nintendo eShop to copy the QUZ0 package into USER NAND.
        </div>
      </div>
    );
  }

  const questions = quizPackage.questions;
  const maxScore = questions.length * quizPackage.pointsPerCorrect;

  const answer = async (choice: number) => {
    const nextScore =
      choice === questions[idx].ans ? score + quizPackage.pointsPerCorrect : score;
    switchAudio.play(choice === questions[idx].ans ? 'select' : 'error');
    setScore(nextScore);
    if (idx + 1 >= questions.length) {
      setDone(true);
      await onSaveScore(title.id, nextScore);
    } else {
      setIdx((i) => i + 1);
    }
  };

  if (done) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-4 bg-[#0D1418]">
        <div className="font-display text-2xl font-bold">Quiz Complete!</div>
        <div className="text-sm font-mono-tabular text-emerald-400">
          Score: {score} / {maxScore} (Saved to USER NAND)
        </div>
        <button
          onClick={() => {
            setIdx(0);
            setScore(0);
            setDone(false);
          }}
          className="px-4 py-2 rounded bg-[#0AB9E6] text-slate-950 text-xs font-bold cursor-pointer"
        >
          Play Again
        </button>
      </div>
    );
  }

  const item = questions[idx];
  return (
    <div className="w-full h-full flex flex-col items-center justify-center p-6 bg-[#0D1418]">
      <div className="w-full max-w-lg space-y-5">
        <div className="flex items-center justify-between text-xs font-mono-tabular">
          <span className="text-[#0AB9E6]">
            Question {idx + 1} of {questions.length} · Score {score}
          </span>
          <span className="text-slate-400">
            USER:/user/apps/title-trivia.pkg (QUZ0 v{quizPackage.version})
          </span>
        </div>
        <h2 className="font-display font-bold text-lg">{item.q}</h2>
        <div className="grid grid-cols-2 gap-3">
          {item.opts.map((opt, oIdx) => (
            <button
              key={opt}
              onClick={() => answer(oIdx)}
              className="p-3.5 rounded-lg bg-[#161E24] hover:bg-[#1D2832] border border-slate-700 text-left text-sm font-semibold cursor-pointer"
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
