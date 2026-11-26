import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  HardDrive,
  Play,
  ShieldCheck,
  Upload,
  XCircle,
} from 'lucide-react';
import { crc32, formatHex32, formatHexDump, sha256HexSync } from '../nand/crc32';
import {
  downloadFullNandBin,
  restoreFullNandFromFile,
} from '../nand/nandBackupUtils';
import { nandStore } from '../nand/nandChunkStore';
import { reassembleChunks } from '../nand/nandFs';
import {
  BootFailure,
  BootLogLine,
  NandAuditReport,
  NandChunkRecord,
  NandPartitionMeta,
  PartitionId,
} from '../nand/nandTypes';

interface BootScreenProps {
  stage: 'PROVISIONING' | 'STAGE1' | 'STAGE2' | 'SPLASH' | 'MAINTENANCE' | 'ERROR';
  logs: BootLogLine[];
  failure: BootFailure | null;
  onEnterMaintenance: () => void;
  onBootNormal: (fast?: boolean) => void;
  onRepairAndBoot: (partitionId?: PartitionId) => void;
}

/**
 * Realistic bricked-console symptom:
 * Displays the crimson console splash logo for ~2.1s, abruptly cuts to black,
 * boot-loops once back to splash, then powers off completely (refusing to reach HOME).
 */
const BrickedSplashLoop: React.FC<{
  onRetryLoop: () => void;
  onOpenMaintenance?: () => void;
}> = ({ onRetryLoop, onOpenMaintenance }) => {
  const [step, setStep] = useState<'SPLASH_1' | 'CUT_1' | 'SPLASH_2' | 'OFF'>(
    'SPLASH_1'
  );

  useEffect(() => {
    const t1 = setTimeout(() => setStep('CUT_1'), 2100);
    const t2 = setTimeout(() => setStep('SPLASH_2'), 3000);
    const t3 = setTimeout(() => setStep('OFF'), 5000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  if (step === 'CUT_1' || step === 'OFF') {
    return (
      <div
        onClick={step === 'OFF' ? onRetryLoop : undefined}
        className={`w-full h-full bg-black select-none flex flex-col items-center justify-end pb-8 ${
          step === 'OFF' ? 'cursor-pointer' : ''
        }`}
        aria-label="Console powered off"
      >
        {step === 'OFF' && (
          <div className="flex flex-col items-center gap-2 text-center px-4">
            <span className="text-xs text-zinc-600">Console powered off following boot fault. Click to retry.</span>
            {onOpenMaintenance && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenMaintenance();
                }}
                className="text-xs text-[#0AB9E6] hover:text-[#38BDF8] underline cursor-pointer"
              >
                Press Esc or click here to open Bootloader Maintenance & Recovery
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-[#E60012] text-white flex flex-col items-center justify-center select-none overflow-hidden">
      <svg
        viewBox="0 0 120 120"
        className="w-24 h-24"
        aria-label="Console Splash"
      >
        <rect
          x="16"
          y="14"
          width="36"
          height="92"
          rx="14"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="8"
        />
        <circle cx="34" cy="42" r="7" fill="#FFFFFF" />
        <path
          d="M66 14h18a16 16 0 0 1 16 16v60a16 16 0 0 1-16 16H66V14z"
          fill="#FFFFFF"
        />
        <circle cx="83" cy="68" r="7.5" fill="#E60012" />
      </svg>
      <div className="font-display text-2xl font-extrabold tracking-[0.18em] mt-5">
        HORIZON NX
      </div>
    </div>
  );
};

export const BootScreen: React.FC<BootScreenProps> = ({
  stage,
  failure,
  onEnterMaintenance,
  onBootNormal,
  onRepairAndBoot,
}) => {
  const [partitions, setPartitions] = useState<NandPartitionMeta[]>([]);
  const [selectedPart, setSelectedPart] = useState<PartitionId>('BOOT0');
  const [chunks, setChunks] = useState<NandChunkRecord[]>([]);
  const [selectedChunkIdx, setSelectedChunkIdx] = useState<number>(0);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [auditReport, setAuditReport] = useState<NandAuditReport | null>(null);
  const [showAuditPanel, setShowAuditPanel] = useState(false);
  const [brickLoopKey, setBrickLoopKey] = useState(1);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadMaintenanceData = async (pid: PartitionId = selectedPart, refreshAudit = false) => {
    const parts = await nandStore.listPartitions();
    setPartitions(parts);
    const recs = await nandStore.getPartitionChunkRecords(pid);
    setChunks(recs);
    setSelectedChunkIdx(0);
    if (refreshAudit || showAuditPanel) {
      const report = await nandStore.auditNandConsistency();
      setAuditReport(report);
    }
  };

  useEffect(() => {
    if (stage === 'MAINTENANCE') {
      const targetPid = failure?.partition ?? selectedPart;
      loadMaintenanceData(targetPid, true);
      if (failure?.partition) {
        setSelectedPart(failure.partition);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, failure]);

  const handleVerifyAll = async () => {
    const report = await nandStore.auditNandConsistency();
    setAuditReport(report);
    setShowAuditPanel(true);
    setStatusBanner(
      report.allPassed
        ? `Cryptographic & structural audit passed (${report.passedCount}/${report.totalCount} checks).`
        : `Audit detected faults: ${report.passedCount}/${report.totalCount} checks passed.`
    );
  };

  const handleSelectPartition = async (pid: PartitionId) => {
    setSelectedPart(pid);
    const recs = await nandStore.getPartitionChunkRecords(pid);
    setChunks(recs);
    setSelectedChunkIdx(0);
  };

  const handleCorruptChunk = async () => {
    if (chunks.length === 0) return;
    await nandStore.corruptChunk(selectedPart, selectedChunkIdx);
    await loadMaintenanceData(selectedPart, true);
    setStatusBanner(
      `Injected 16-byte bit-rot into ${selectedPart} chunk #${selectedChunkIdx}. Booting now will exhibit a splash-loop brick.`
    );
  };

  const handleWipePartition = async () => {
    await nandStore.wipePartitionChunks(selectedPart);
    await loadMaintenanceData(selectedPart, true);
    setStatusBanner(
      `Wiped all IDB chunks from ${selectedPart}. Booting now will fail Stage 1/2 verification.`
    );
  };

  const handleRepairPartition = async (pid: PartitionId) => {
    await nandStore.repairPartition(pid);
    await loadMaintenanceData(pid, true);
    setStatusBanner(`Re-flashed ${pid} factory Uint8Array chunks into IndexedDB.`);
  };

  const handleFullReflash = async () => {
    await nandStore.flashFactoryNand();
    await loadMaintenanceData(selectedPart, true);
    setStatusBanner('All 8 GPT partitions re-flashed to factory IndexedDB state.');
  };

  const handleDumpNandBin = async () => {
    try {
      const res = await downloadFullNandBin('NXEMMC');
      setStatusBanner(
        `Dumped ${res.partitionCount} partitions (${(res.totalBytes / 1024).toFixed(1)} KiB) to ${res.filename}.`
      );
    } catch (err) {
      setStatusBanner(
        err instanceof Error ? err.message : 'Failed to export NAND .bin'
      );
    }
  };

  const handleRestoreNandFile = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const res = await restoreFullNandFromFile(file);
      await loadMaintenanceData(selectedPart, true);
      setStatusBanner(
        `Restored ${res.partitionCount} partitions (${(res.totalBytesRestored / 1024).toFixed(1)} KiB) from ${file.name}. Ready to boot!`
      );
    } catch (err) {
      setStatusBanner(
        err instanceof Error ? err.message : 'Invalid or corrupt NAND .bin file'
      );
    }
  };

  // During normal cold boot (PROVISIONING, STAGE1, STAGE2, SPLASH), keep console screen pure black until HOME Menu is ready
  if (
    stage === 'PROVISIONING' ||
    stage === 'STAGE1' ||
    stage === 'STAGE2' ||
    stage === 'SPLASH'
  ) {
    return (
      <div
        className="w-full h-full bg-black select-none"
        aria-label="Booting console..."
      />
    );
  }

  // ERROR SCREEN: Realistic Bricked Console Behavior (Boot Loops / Freezes on Splash Screen)
  if (stage === 'ERROR') {
    return (
      <BrickedSplashLoop
        key={brickLoopKey}
        onRetryLoop={() => setBrickLoopKey((k) => k + 1)}
        onOpenMaintenance={onEnterMaintenance}
      />
    );
  }

  // MAINTENANCE / INTERACTIVE BOOTLOADER MENU
  if (stage === 'MAINTENANCE') {
    const activeMeta = partitions.find((p) => p.id === selectedPart);
    const activeChunk = chunks[selectedChunkIdx];
    const hexLines = activeChunk ? formatHexDump(activeChunk.data, 18) : [];
    const activeChunkLiveCrc = activeChunk ? crc32(activeChunk.data) : 0;
    const activeChunkOk = activeChunk
      ? activeChunkLiveCrc === activeChunk.crc32 && activeChunk.data.length === activeChunk.byteLength
      : true;
    const livePartSha256 =
      activeMeta && chunks.length === activeMeta.chunkCount && chunks.length > 0
        ? sha256HexSync(reassembleChunks(chunks.map((c) => c.data)))
        : null;
    const partShaOk = activeMeta ? livePartSha256 === activeMeta.sha256 : false;

    return (
      <div className="w-full h-full bg-[#0C0F14] text-slate-100 flex flex-col overflow-hidden">
        <input
          ref={fileInputRef}
          type="file"
          accept=".bin"
          onChange={handleRestoreNandFile}
          className="hidden"
        />

        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-[#11161F] gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Cpu className="w-4 h-4 text-[#0AB9E6] shrink-0" />
            <span className="font-display font-bold text-sm tracking-tight truncate">
              NX-BOOT Maintenance & NAND Backup
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => (showAuditPanel ? setShowAuditPanel(false) : handleVerifyAll())}
              className={`px-2.5 py-1.5 rounded-md text-xs font-medium border flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                auditReport && !auditReport.allPassed
                  ? 'bg-red-950/70 hover:bg-red-900/80 border-red-700 text-red-200'
                  : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              {auditReport
                ? `Audit ${auditReport.passedCount}/${auditReport.totalCount}`
                : 'Verify NAND'}
            </button>
            <button
              onClick={handleDumpNandBin}
              className="px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 border border-slate-700 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5 text-[#0AB9E6]" />
              Dump .bin
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 border border-slate-700 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <Upload className="w-3.5 h-3.5 text-emerald-400" />
              Restore .bin
            </button>
            <button
              onClick={() => onBootNormal(false)}
              className="px-3 py-1.5 rounded-md bg-[#0AB9E6] hover:bg-[#09a5ce] text-slate-950 text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              Boot Console
            </button>
          </div>
        </div>

        {failure && !statusBanner && (
          <div className="px-5 py-2 bg-red-950/60 border-b border-red-800/60 text-xs text-red-200 flex items-center justify-between">
            <span>
              Last boot halted at {failure.stage} ({failure.partition} · {failure.code}):{' '}
              {failure.reason}
            </span>
          </div>
        )}

        {statusBanner && (
          <div className="px-5 py-2 bg-sky-950/60 border-b border-sky-800/60 text-xs text-sky-200 flex items-center justify-between">
            <span>{statusBanner}</span>
            <button
              onClick={() => setStatusBanner(null)}
              className="text-sky-300 hover:text-white text-xs ml-4 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {showAuditPanel && auditReport && (
          <div className="border-b border-slate-800 bg-[#0A0D13] px-4 py-2.5 max-h-44 overflow-y-auto thin-scrollbar">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-bold font-mono-tabular text-slate-300">
                Cross-Partition Cryptographic Audit ({auditReport.passedCount}/{auditReport.totalCount} Passed)
              </span>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleVerifyAll}
                  className="text-[11px] text-[#0AB9E6] hover:underline cursor-pointer"
                >
                  Re-run
                </button>
                <button
                  onClick={() => setShowAuditPanel(false)}
                  className="text-[11px] text-slate-400 hover:text-white cursor-pointer"
                >
                  Hide
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {auditReport.checks.map((chk) => (
                <div
                  key={chk.id}
                  className={`px-2.5 py-1.5 rounded border text-[11px] flex items-start gap-2 ${
                    chk.passed
                      ? 'bg-emerald-950/20 border-emerald-900/50 text-emerald-200'
                      : 'bg-red-950/40 border-red-800/70 text-red-200'
                  }`}
                >
                  {chk.passed ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0">
                    <div className="font-semibold truncate">
                      [{chk.category}] {chk.label}
                    </div>
                    <div className="text-[10px] text-slate-400 truncate">{chk.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex-1 grid grid-cols-12 min-h-0">
          {/* Left: Partition List */}
          <div className="col-span-4 border-r border-slate-800 p-3 overflow-y-auto thin-scrollbar space-y-1.5">
            <div className="text-[11px] font-medium text-slate-400 px-2 pb-1 flex items-center justify-between">
              <span>GPT eMMC Partitions</span>
              <button
                onClick={handleFullReflash}
                className="text-[#0AB9E6] hover:underline cursor-pointer"
              >
                Re-Flash All
              </button>
            </div>
            {partitions.map((p) => {
              const isSelected = p.id === selectedPart;
              return (
                <button
                  key={p.id}
                  onClick={() => handleSelectPartition(p.id)}
                  className={`w-full text-left p-2.5 rounded-md border transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-[#172130] border-[#0AB9E6]/70 text-white'
                      : 'bg-[#12161E] border-slate-800/80 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono-tabular text-xs font-bold">{p.id}</span>
                    <span className="text-[10px] font-mono-tabular text-slate-400">
                      {p.requiredBy}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5 truncate">
                    {p.description}
                  </div>
                  <div className="text-[10px] font-mono-tabular text-slate-500 mt-1">
                    {p.chunkCount} chunks · {(p.usedBytes / 1024).toFixed(1)} KiB ·{' '}
                    {formatHex32(p.partitionCrc32)}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right: Chunk Inspector & Hex View */}
          <div className="col-span-8 p-4 flex flex-col min-h-0 overflow-y-auto thin-scrollbar">
            {activeMeta && (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-slate-800">
                  <div>
                    <div className="flex items-center gap-2">
                      <HardDrive className="w-4 h-4 text-[#0AB9E6]" />
                      <h3 className="font-display font-bold text-sm text-white">
                        {activeMeta.label}
                      </h3>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">
                      LBA {activeMeta.startLba.toLocaleString()}–
                      {activeMeta.endLba.toLocaleString()} ·{' '}
                      <span
                        className={`font-mono-tabular ${
                          partShaOk ? 'text-emerald-400' : 'text-red-400 font-bold'
                        }`}
                      >
                        SHA-256 {activeMeta.sha256.slice(0, 14)}… ({partShaOk ? 'Verified' : 'Mismatch'})
                      </span>
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleCorruptChunk}
                      disabled={chunks.length === 0}
                      className="px-2.5 py-1.5 rounded bg-amber-950/70 hover:bg-amber-900/80 border border-amber-700/60 text-amber-200 text-[11px] font-medium disabled:opacity-40 cursor-pointer"
                    >
                      Corrupt Chunk #{selectedChunkIdx}
                    </button>
                    <button
                      onClick={handleWipePartition}
                      className="px-2.5 py-1.5 rounded bg-red-950/70 hover:bg-red-900/80 border border-red-800/60 text-red-200 text-[11px] font-medium cursor-pointer"
                    >
                      Wipe Chunks
                    </button>
                    <button
                      onClick={() => handleRepairPartition(activeMeta.id)}
                      className="px-2.5 py-1.5 rounded bg-emerald-950/70 hover:bg-emerald-900/80 border border-emerald-700/60 text-emerald-200 text-[11px] font-medium cursor-pointer"
                    >
                      Repair {activeMeta.id}
                    </button>
                  </div>
                </div>

                {/* Chunk Selector Strip */}
                <div className="mt-3">
                  <div className="text-[11px] text-slate-400 mb-1.5 flex items-center justify-between">
                    <span>
                      IndexedDB Uint8Array Chunks ({chunks.length} / {activeMeta.chunkCount} present,{' '}
                      {activeMeta.chunkSize / 1024} KiB block size)
                    </span>
                  </div>
                  {chunks.length === 0 ? (
                    <div className="p-4 rounded bg-red-950/30 border border-red-900/50 text-xs text-red-300 flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      No chunks found in IndexedDB for {selectedPart}. Click &ldquo;Repair{' '}
                      {selectedPart}&rdquo; to restore.
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {chunks.map((c) => {
                        const isSel = c.chunkIndex === selectedChunkIdx;
                        const crcOk = crc32(c.data) === c.crc32 && c.data.length === c.byteLength;
                        return (
                          <button
                            key={c.key}
                            onClick={() => setSelectedChunkIdx(c.chunkIndex)}
                            className={`px-2.5 py-1 rounded text-[11px] font-mono-tabular border cursor-pointer ${
                              isSel
                                ? crcOk
                                  ? 'bg-[#0AB9E6] text-slate-950 border-[#0AB9E6] font-bold'
                                  : 'bg-red-500 text-white border-red-400 font-bold'
                                : crcOk
                                  ? 'bg-[#141922] text-slate-300 border-slate-800 hover:border-slate-600'
                                  : 'bg-red-950/60 text-red-300 border-red-700'
                            }`}
                          >
                            Chunk #{c.chunkIndex} ({c.byteLength}B{crcOk ? '' : ' · CRC FAIL'})
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Hex Dump of Active Chunk */}
                {activeChunk && (
                  <div className="mt-3 flex-1 min-h-0 flex flex-col">
                    <div className="text-[11px] font-mono-tabular text-slate-400 mb-1 flex items-center justify-between">
                      <span>
                        IDB Key: {activeChunk.key} · Stored {formatHex32(activeChunk.crc32)} · Live{' '}
                        <span className={activeChunkOk ? 'text-emerald-400' : 'text-red-400 font-bold'}>
                          {formatHex32(activeChunkLiveCrc)} ({activeChunkOk ? 'MATCH' : 'CORRUPT'})
                        </span>
                      </span>
                      <span>First 288 bytes</span>
                    </div>
                    <pre className="flex-1 bg-[#07090D] border border-slate-800 rounded-md p-3 font-mono-tabular text-[11px] leading-relaxed text-emerald-300/90 overflow-auto thin-scrollbar">
                      {hexLines.join('\n')}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return <div className="w-full h-full bg-black select-none" />;
};
