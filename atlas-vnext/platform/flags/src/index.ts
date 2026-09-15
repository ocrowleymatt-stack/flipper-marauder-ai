/**
 * Platform kill switches and experiment flags.
 *
 * These are operational controls, not Authority. Disabling a surface refuses
 * work; it never grants capabilities. Persistence of flag history is deferred;
 * production reads process environment shared across instances.
 */
export interface FeatureFlagStore {
  enabled(flag: string, context?: { projectId?: string; dungeon?: string }): boolean;
}

export class FlagsNotImplementedError extends Error {
  constructor() {
    super('platform/flags persistence is deferred; the interface is the contract.');
    this.name = 'FlagsNotImplementedError';
  }
}

export const KILL_SWITCH_FLAGS = ['tools', 'generation', 'dungeon.writing', 'providers'] as const;
export type KillSwitchFlag = (typeof KILL_SWITCH_FLAGS)[number];

export interface KillSwitchState {
  tools: boolean;
  generation: boolean;
  dungeonWriting: boolean;
  disabledProviders: string[];
}

/**
 * Environment-backed flags. Missing keys default to enabled (fail open for
 * optional experiments). Explicit `0`/`off`/`false` disables. Provider kill is
 * a disable-list, never a hardcoded fallback chain.
 */
export class EnvFlagStore implements FeatureFlagStore {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  enabled(flag: string, _context?: { projectId?: string; dungeon?: string }): boolean {
    if (flag === 'tools') return this.on('ATLAS_FLAG_TOOLS');
    if (flag === 'generation') return this.on('ATLAS_FLAG_GENERATION');
    if (flag === 'dungeon.writing' || flag === 'dungeonWriting') return this.on('ATLAS_FLAG_DUNGEON_WRITING');
    if (flag === 'providers') return this.disabledProviders().length === 0 || this.on('ATLAS_FLAG_PROVIDERS');
    const key = `ATLAS_FLAG_${flag.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
    return this.on(key);
  }

  disabledProviders(): string[] {
    const raw = this.env.ATLAS_KILL_PROVIDERS ?? this.env.ATLAS_FLAG_PROVIDERS_DISABLE ?? '';
    return raw
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }

  snapshot(): KillSwitchState {
    return {
      tools: this.enabled('tools'),
      generation: this.enabled('generation'),
      dungeonWriting: this.enabled('dungeon.writing'),
      disabledProviders: this.disabledProviders(),
    };
  }

  private on(key: string): boolean {
    const raw = this.env[key];
    if (raw === undefined || raw === '') return true;
    const value = raw.trim().toLowerCase();
    return value !== '0' && value !== 'off' && value !== 'false' && value !== 'disabled';
  }
}

export function readKillSwitches(env: Record<string, string | undefined> = process.env): KillSwitchState {
  return new EnvFlagStore(env).snapshot();
}
