import { useCallback, useEffect, useState } from 'react';
import { switchAudio } from './audio/switchAudio';
import { runConsoleBootSequence } from './boot/bootloaderEngine';
import { BootScreen } from './components/BootScreen';
import { ConsoleShell } from './components/ConsoleShell';
import { HomeMenu } from './components/HomeMenu';
import {
  encodeAlb0,
  encodePrf0,
  encodeSet0,
  encodeTit0,
} from './nand/binaryStructs';
import { buildGameSaveBinary } from './nand/nandFactoryImage';
import { nandStore } from './nand/nandChunkStore';
import {
  AlbumCapture,
  BootedSystemContext,
  BootFailure,
  BootLogLine,
  ConsoleSettings,
  EshopListing,
  InstalledTitle,
  PartitionId,
  QuizPackage,
  UserProfile,
} from './nand/nandTypes';
import { executeBatteryPolicyVm, NXVM_REG } from './nand/nxVm';
import { decodeQuizPackage } from './nand/systemAssets';

type BootPhase =
  | 'PROVISIONING'
  | 'STAGE1'
  | 'STAGE2'
  | 'SPLASH'
  | 'MAINTENANCE'
  | 'ERROR'
  | 'HOME';

export default function App() {
  const [phase, setPhase] = useState<BootPhase>('STAGE1');
  const [bootLogs, setBootLogs] = useState<BootLogLine[]>([]);
  const [failure, setFailure] = useState<BootFailure | null>(null);
  const [system, setSystem] = useState<BootedSystemContext | null>(null);
  const [dockedFullscreen, setDockedFullscreen] = useState(false);
  const [joyConSignal, setJoyConSignal] = useState<{
    button: string;
    seq: number;
  } | null>(null);

  const executeBoot = useCallback(async (fastBoot = false) => {
    setFailure(null);
    setBootLogs([]);
    setSystem(null);
    setPhase('STAGE1');

    try {
      const ctx = await runConsoleBootSequence(
        {
          onStageChange: (next) => setPhase(next),
          onLog: (line) => setBootLogs((prev) => [...prev, line]),
        },
        { fastBoot }
      );
      switchAudio.configure(
        ctx.sfxTable,
        ctx.settings.volume,
        ctx.settings.muted
      );
      switchAudio.playBootChime(ctx.bootChime);
      setSystem(ctx);
      setPhase('HOME');
    } catch (err) {
      const bf = err as BootFailure;
      setFailure(bf);
      setPhase('ERROR');
    }
  }, []);

  useEffect(() => {
    executeBoot(false);
  }, [executeBoot]);

  // Allow pressing Esc during Stage 1/2 boot or error to jump into Bootloader Maintenance
  useEffect(() => {
    if (
      phase !== 'STAGE1' &&
      phase !== 'STAGE2' &&
      phase !== 'PROVISIONING' &&
      phase !== 'ERROR'
    ) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPhase('MAINTENANCE');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]);

  const handleReboot = useCallback(
    (mode: 'NORMAL' | 'MAINTENANCE') => {
      if (mode === 'MAINTENANCE') {
        setSystem(null);
        setPhase('MAINTENANCE');
      } else {
        executeBoot(false);
      }
    },
    [executeBoot]
  );

  const handleRepairAndBoot = useCallback(
    async (partitionId?: PartitionId) => {
      if (partitionId) {
        await nandStore.repairPartition(partitionId);
      } else {
        await nandStore.flashFactoryNand();
      }
      await executeBoot(false);
    },
    [executeBoot]
  );

  const handleUpdateSettings = useCallback(
    async (patch: Partial<ConsoleSettings>) => {
      if (!system) return;
      const nextSettings: ConsoleSettings = { ...system.settings, ...patch };
      await nandStore.updatePartitionFile(
        'USER',
        '/user/save/settings.bin',
        encodeSet0(nextSettings)
      );
      switchAudio.configure(
        system.sfxTable,
        nextSettings.volume,
        nextSettings.muted
      );
      let nextTelemetry = system.batteryTelemetry;
      if (
        'brightness' in patch ||
        'airplaneMode' in patch ||
        'dockedMode' in patch
      ) {
        try {
          const sysRes = await nandStore.readPartitionFiles('SYSTEM');
          const vmBytes = sysRes.files['/sys/code/battery_policy.nxb'];
          if (vmBytes) {
            nextTelemetry = executeBatteryPolicyVm(vmBytes, {
              [NXVM_REG.BAT_CAPACITY_MAH]: system.hardwareCal.battery.capacityMah,
              [NXVM_REG.BAT_CYCLES]: system.hardwareCal.battery.factoryCycles,
              [NXVM_REG.BAT_RESIST_MOHM]:
                system.hardwareCal.battery.internalResistanceMohm,
              [NXVM_REG.SET_BRIGHTNESS]: nextSettings.brightness,
              [NXVM_REG.SET_AIRPLANE]: nextSettings.airplaneMode ? 1 : 0,
              [NXVM_REG.SET_DOCKED]: nextSettings.dockedMode ? 1 : 0,
              [NXVM_REG.PROD_FUSES]: system.prodInfo.fuseCount,
            });
          }
        } catch {
          // keep prior telemetry if SYSTEM read unavailable
        }
      }
      setSystem((prev) =>
        prev
          ? { ...prev, settings: nextSettings, batteryTelemetry: nextTelemetry }
          : prev
      );
    },
    [system]
  );

  const handleUpdateProfiles = useCallback(
    async (profiles: UserProfile[]) => {
      if (!system) return;
      await nandStore.updatePartitionFile(
        'USER',
        '/user/save/profiles.bin',
        encodePrf0(profiles)
      );
      setSystem((prev) => (prev ? { ...prev, profiles } : prev));
    },
    [system]
  );

  const handleInstallTitle = useCallback(
    async (listing: EshopListing) => {
      if (!system) return;
      if (system.titles.some((t) => t.id === listing.id)) return;
      const newTitle: InstalledTitle = {
        id: listing.id,
        title: listing.title,
        publisher: listing.publisher,
        version: listing.version,
        category: listing.category,
        artworkId: listing.artworkId,
        runnerType: listing.runnerType,
        sizeMb: listing.sizeMb,
        playMinutes: 0,
        lastPlayed: Date.now(),
        highScore: 0,
        saveFilePath: `/user/save/${listing.id}.dat`,
        pinnedOrder: 0,
      };
      const updated = [newTitle, ...system.titles];
      await nandStore.updatePartitionFile(
        'USER',
        '/user/titles/registry.bin',
        encodeTit0(updated)
      );
      // Synchronize newly installed title with a valid factory SAVE structure
      await nandStore.updatePartitionFile(
        'USER',
        newTitle.saveFilePath,
        buildGameSaveBinary(
          newTitle.id,
          0,
          0,
          newTitle.lastPlayed,
          newTitle.highScore !== undefined,
          system.settings.activeUserId
        )
      );
      // Copy binary executable/asset package from SYSTEM /sys/eshop/<id>.pkg into USER /user/apps/<id>.pkg
      let installedQuizPkg: QuizPackage | null = system.quizPackage;
      const sysRes = await nandStore.readPartitionFiles('SYSTEM');
      const eshopPkgBytes = sysRes.files[`/sys/eshop/${listing.id}.pkg`];
      if (eshopPkgBytes) {
        await nandStore.updatePartitionFile(
          'USER',
          `/user/apps/${listing.id}.pkg`,
          eshopPkgBytes
        );
        if (listing.id === 'title-trivia') {
          installedQuizPkg = decodeQuizPackage(eshopPkgBytes);
        }
      }
      setSystem((prev) =>
        prev ? { ...prev, titles: updated, quizPackage: installedQuizPkg } : prev
      );
    },
    [system]
  );

  const handleDeleteTitle = useCallback(
    async (titleId: string) => {
      if (!system) return;
      const target = system.titles.find((t) => t.id === titleId);
      const updated = system.titles.filter((t) => t.id !== titleId);
      await nandStore.updatePartitionFile(
        'USER',
        '/user/titles/registry.bin',
        encodeTit0(updated)
      );
      if (target) {
        await nandStore.deletePartitionFile('USER', target.saveFilePath);
      }
      const userRes = await nandStore.readPartitionFiles('USER');
      const pkgPath = `/user/apps/${titleId}.pkg`;
      if (userRes.files[pkgPath]) {
        await nandStore.deletePartitionFile('USER', pkgPath);
      }
      setSystem((prev) =>
        prev
          ? {
              ...prev,
              titles: updated,
              quizPackage: titleId === 'title-trivia' ? null : prev.quizPackage,
            }
          : prev
      );
    },
    [system]
  );

  const handleSaveScore = useCallback(
    async (titleId: string, score: number) => {
      if (!system) return;
      let targetTitle: InstalledTitle | null = null;
      const updated = system.titles.map((t) => {
        if (t.id !== titleId) return t;
        const newScore = Math.max(t.highScore ?? 0, score);
        const newPlayMinutes = t.playMinutes + 5;
        const now = Date.now();
        targetTitle = {
          ...t,
          playMinutes: newPlayMinutes,
          lastPlayed: now,
          highScore: newScore,
        };
        return targetTitle;
      });
      await nandStore.updatePartitionFile(
        'USER',
        '/user/titles/registry.bin',
        encodeTit0(updated)
      );
      // Synchronize the binary SAVE file on disk with the registry score
      if (targetTitle) {
        const titleRef = targetTitle as InstalledTitle;
        await nandStore.updatePartitionFile(
          'USER',
          titleRef.saveFilePath,
          buildGameSaveBinary(
            titleRef.id,
            titleRef.highScore ?? 0,
            titleRef.playMinutes,
            titleRef.lastPlayed,
            titleRef.highScore !== undefined,
            system.settings.activeUserId
          )
        );
      }
      setSystem((prev) => (prev ? { ...prev, titles: updated } : prev));
    },
    [system]
  );

  const handleSaveCapture = useCallback(
    async (capture: AlbumCapture) => {
      if (!system) return;
      const updated = [capture, ...system.album];
      await nandStore.updatePartitionFile(
        'USER',
        '/user/album/captures.bin',
        encodeAlb0(updated)
      );
      setSystem((prev) => (prev ? { ...prev, album: updated } : prev));
    },
    [system]
  );

  const handleDeleteCapture = useCallback(
    async (id: string) => {
      if (!system) return;
      const updated = system.album.filter((c) => c.id !== id);
      await nandStore.updatePartitionFile(
        'USER',
        '/user/album/captures.bin',
        encodeAlb0(updated)
      );
      setSystem((prev) => (prev ? { ...prev, album: updated } : prev));
    },
    [system]
  );

  const handleFactoryReset = useCallback(async () => {
    await nandStore.flashFactoryNand();
    await executeBoot(false);
  }, [executeBoot]);

  const activeStageLabel =
    phase === 'HOME' && system
      ? `HOS ${system.osManifest.osVersion} · ${system.prodInfo.serial} · ${system.totalChunksRead} IDB Chunks Booted`
      : phase === 'MAINTENANCE'
        ? 'NX-BOOT Maintenance Mode'
        : phase === 'ERROR'
          ? `Boot Fault (${failure?.code ?? 'ERR'})`
          : `Executing ${phase}…`;

  return (
    <ConsoleShell
      brightness={system?.settings.brightness ?? 100}
      muted={system?.settings.muted ?? false}
      dockedFullscreen={dockedFullscreen}
      onToggleFullscreen={() => setDockedFullscreen((v) => !v)}
      onToggleMute={() => {
        if (system) {
          handleUpdateSettings({ muted: !system.settings.muted });
        }
      }}
      onReboot={handleReboot}
      onJoyConPress={(button) =>
        setJoyConSignal((prev) => ({ button, seq: (prev?.seq ?? 0) + 1 }))
      }
      activeStageLabel={activeStageLabel}
    >
      {phase === 'HOME' && system ? (
        <HomeMenu
          system={system}
          onUpdateSettings={handleUpdateSettings}
          onUpdateProfiles={handleUpdateProfiles}
          onInstallTitle={handleInstallTitle}
          onDeleteTitle={handleDeleteTitle}
          onSaveScore={handleSaveScore}
          onSaveCapture={handleSaveCapture}
          onDeleteCapture={handleDeleteCapture}
          onReboot={handleReboot}
          onFactoryReset={handleFactoryReset}
          externalButtonSignal={joyConSignal}
        />
      ) : (
        <BootScreen
          stage={phase === 'HOME' ? 'STAGE1' : phase}
          logs={bootLogs}
          failure={failure}
          onEnterMaintenance={() => setPhase('MAINTENANCE')}
          onBootNormal={(fast) => executeBoot(Boolean(fast))}
          onRepairAndBoot={handleRepairAndBoot}
        />
      )}
    </ConsoleShell>
  );
}
