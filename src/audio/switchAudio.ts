import { BootChimeNote, UiSfxTable } from '../nand/nandTypes';
import { DEFAULT_SFX_TABLE } from '../nand/nandFactoryImage';

class SwitchAudioEngine {
  private ctx: AudioContext | null = null;
  private table: UiSfxTable = DEFAULT_SFX_TABLE;
  private volume = 0.75;
  private muted = false;

  public configure(table: UiSfxTable, volumePercent: number, muted: boolean): void {
    this.table = table;
    this.volume = Math.max(0, Math.min(1, volumePercent / 100));
    this.muted = muted;
  }

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (Ctor) {
        this.ctx = new Ctor();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public play(kind: keyof UiSfxTable): void {
    if (this.muted || this.volume <= 0.01) return;
    const ctx = this.getContext();
    if (!ctx) return;

    const p = this.table[kind];
    if (!p) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc.type = p.type;
    osc.frequency.setValueAtTime(p.freq, now);
    if (p.freqEnd && p.freqEnd !== p.freq) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(40, p.freqEnd),
        now + p.durationMs / 1000
      );
    }

    const peak = p.gain * this.volume;
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), now + 0.008);
    gainNode.gain.exponentialRampToValueAtTime(
      0.0001,
      now + Math.max(0.02, p.durationMs / 1000)
    );

    osc.connect(gainNode);
    gainNode.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + p.durationMs / 1000 + 0.015);
  }

  public playTone(
    freqHz: number,
    durationMs: number,
    type: 'sine' | 'triangle' | 'square' = 'triangle',
    gain = 0.08
  ): void {
    if (this.muted || this.volume <= 0.01) return;
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(40, freqHz), now);
    const peak = gain * this.volume;
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), now + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(
      0.0001,
      now + Math.max(0.03, durationMs / 1000)
    );
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + durationMs / 1000 + 0.02);
  }

  public playBootChime(notes: BootChimeNote[]): void {
    if (this.muted || this.volume <= 0.01 || notes.length === 0) return;
    const ctx = this.getContext();
    if (!ctx) return;
    const base = ctx.currentTime + 0.02;
    for (const n of notes) {
      const start = base + n.startMs / 1000;
      const dur = Math.max(0.04, n.durationMs / 1000);
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.type = n.wave;
      osc.frequency.setValueAtTime(Math.max(40, n.freqHz), start);
      const peak = n.gain * this.volume;
      gainNode.gain.setValueAtTime(0.0001, start);
      gainNode.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), start + 0.012);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    }
  }
}

export const switchAudio = new SwitchAudioEngine();
