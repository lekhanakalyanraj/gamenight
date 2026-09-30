/**
 * The TV's narrator: plays each voiced line once, in the order the lines were shown, never two at a time.
 *
 * Browsers block sound until someone interacts with the page, so the TV starts locked: one tap ("Start the
 * show") plays a silent clip on an audio element, and every line is then played on that same element (which
 * is what Safari needs). Captions never wait for any of this. A clip that comes too late after its caption
 * isn't played, and neither is one that waited so long behind others that the room has moved on.
 */

/** A clip arriving more than this long after its caption isn't played: the moment has passed. */
export const LATE_ON_ARRIVAL_MS = 6_000;
/** Nor one that waited this long in the queue behind other lines. */
export const LATE_AT_START_MS = 12_000;

export type NarratorState = "locked" | "ready" | "speaking" | "off";
export type NarratorSnapshot = { state: NarratorState; played: number; skipped: number };

/** Downloads a clip (with the TV's own login: Storage lets it read only its room's clips). */
type FetchClip = (path: string) => Promise<Blob | null>;

export class NarrationPlayer {
  private audio: HTMLAudioElement | null = null;
  private queue: { path: string; shownAt: number }[] = [];
  private seen = new Set<string>();
  private busy = false;
  private speaking = false;
  private enabled = true;
  private played = 0;
  private skipped = 0;
  private offset = 0; // how far the server's clock is ahead of this device's: lines are stamped by the database

  constructor(
    private readonly fetchClip: FetchClip,
    private readonly onChange: (snapshot: NarratorSnapshot) => void,
  ) {}

  setClockOffset(ms: number): void {
    this.offset = ms;
  }

  private now(): number {
    return Date.now() + this.offset;
  }

  snapshot(): NarratorSnapshot {
    const state = !this.enabled ? "off" : !this.audio ? "locked" : this.speaking ? "speaking" : "ready";
    return { state, played: this.played, skipped: this.skipped };
  }

  /** Must run inside a tap: the browser allows sound from then on, on this audio element. */
  async unlock(): Promise<boolean> {
    const audio = new Audio();
    const url = URL.createObjectURL(new Blob([silentWav()], { type: "audio/wav" }));
    try {
      audio.src = url;
      await audio.play();
    } catch {
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
    this.audio = audio;
    this.emit();
    return true;
  }

  /** The host's switch. Off stops the line being spoken and drops the queue. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      this.queue = [];
      this.audio?.pause();
    }
    this.emit();
  }

  /** A clip has arrived for a line shown at `shownAt` (server time). Each line is played at most once. */
  offer(lineId: string, path: string, shownAt: number): void {
    if (this.seen.has(lineId)) return;
    this.seen.add(lineId);
    if (!this.audio || !this.enabled || this.now() - shownAt > LATE_ON_ARRIVAL_MS) {
      this.skipped += 1; // locked, muted or late: the caption already said it
      this.emit();
      return;
    }
    this.queue.push({ path, shownAt });
    this.queue.sort((a, b) => a.shownAt - b.shownAt);
    void this.pump();
  }

  stop(): void {
    this.queue = [];
    this.audio?.pause();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length > 0 && this.audio && this.enabled) {
        const next = this.queue.shift()!;
        if (this.now() - next.shownAt > LATE_AT_START_MS) {
          this.skipped += 1;
          continue;
        }
        const blob = await this.fetchClip(next.path).catch(() => null);
        if (!blob || !this.enabled) {
          this.skipped += 1;
          continue;
        }
        const url = URL.createObjectURL(blob);
        this.speaking = true;
        this.emit();
        try {
          await playToEnd(this.audio, url);
          if (this.enabled) this.played += 1;
        } catch {
          this.skipped += 1;
        } finally {
          URL.revokeObjectURL(url);
        }
      }
    } finally {
      this.busy = false;
      this.speaking = false;
      this.emit();
    }
  }

  private emit(): void {
    this.onChange(this.snapshot());
  }
}

/** Plays a clip; resolves when it ends (or is stopped by the host's switch), rejects if it can't play. */
function playToEnd(audio: HTMLAudioElement, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (ok: boolean) => () => {
      audio.removeEventListener("ended", onEnd);
      audio.removeEventListener("pause", onEnd);
      audio.removeEventListener("error", onError);
      if (ok) resolve();
      else reject(new Error("the clip couldn't be played"));
    };
    const onEnd = finish(true);
    const onError = finish(false);
    audio.addEventListener("ended", onEnd);
    audio.addEventListener("pause", onEnd);
    audio.addEventListener("error", onError);
    audio.src = url;
    audio.play().catch(onError);
  });
}

/** 50 ms of silence (8-bit mono WAV), for unlocking audio without a sound. */
function silentWav(): ArrayBuffer {
  const samples = 400;
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) view.setUint8(44 + i, 128); // 8-bit silence is the midpoint
  return buffer;
}
