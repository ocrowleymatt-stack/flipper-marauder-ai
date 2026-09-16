export type AtlasCue = 'activate' | 'complete' | 'approval' | 'tool' | 'warn';

const SOUND_KEY = 'atlas.sound';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function soundEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(SOUND_KEY) === 'on';
}

export function setSoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off');
}

const CUES: Record<AtlasCue, Array<{ frequency: number; durationMs: number; delayMs: number }>> = {
  activate: [{ frequency: 440, durationMs: 70, delayMs: 0 }],
  complete: [
    { frequency: 523, durationMs: 80, delayMs: 0 },
    { frequency: 659, durationMs: 110, delayMs: 70 },
  ],
  approval: [{ frequency: 330, durationMs: 160, delayMs: 0 }],
  tool: [{ frequency: 880, durationMs: 40, delayMs: 0 }],
  warn: [{ frequency: 196, durationMs: 180, delayMs: 0 }],
};

export function playCue(cue: AtlasCue): void {
  if (!soundEnabled() || prefersReducedMotion()) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (document.hidden) return;
  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;
  const context = new AudioContextCtor();
  for (const note of CUES[cue]) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = note.frequency;
    gain.gain.value = 0.04;
    oscillator.connect(gain);
    gain.connect(context.destination);
    const start = context.currentTime + note.delayMs / 1000;
    oscillator.start(start);
    oscillator.stop(start + note.durationMs / 1000);
  }
  window.setTimeout(() => {
    void context.close();
  }, 400);
}

export function motionClass(name: string): string {
  return prefersReducedMotion() ? name : `${name} atlas-motion`;
}
