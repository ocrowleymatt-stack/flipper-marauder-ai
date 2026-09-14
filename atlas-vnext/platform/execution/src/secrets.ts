/**
 * Single secrets abstraction for the execution plane.
 * Adapters receive this port; they must not read process.env themselves.
 */

export interface SecretStore {
  get(name: string): string | undefined;
}

export const SECRET_KEYS = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  venice: 'VENICE_API_KEY',
  xai: 'XAI_API_KEY',
  grok: 'GROK_API_KEY',
  forge: 'FORGE_API_KEY',
  runpod: 'RUNPOD_API_KEY',
} as const;

/** Gemini accepts either Google AI Studio key name. */
export function geminiApiKey(secrets: SecretStore): string | undefined {
  return secrets.get(SECRET_KEYS.gemini) ?? secrets.get('GOOGLE_API_KEY');
}

/** xAI Grok accepts the official xAI key or the historical GROK_API_KEY alias. */
export function xaiApiKey(secrets: SecretStore): string | undefined {
  return secrets.get(SECRET_KEYS.xai) ?? secrets.get(SECRET_KEYS.grok);
}

/** Private Forge/Hetzner inference may be unauthenticated on a trusted network. */
export function forgeApiKey(secrets: SecretStore): string | undefined {
  return (
    secrets.get(SECRET_KEYS.forge) ??
    secrets.get('ATLAS_FORGE_API_KEY') ??
    secrets.get('HETZNER_INFERENCE_API_KEY')
  );
}

export type CloudProviderId = keyof typeof SECRET_KEYS;

export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  get(name: string): string | undefined {
    const value = this.env[name];
    if (!value) return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}

export class MapSecretStore implements SecretStore {
  constructor(private readonly values: Record<string, string | undefined>) {}

  get(name: string): string | undefined {
    const value = this.values[name];
    if (!value) return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}

export function secretKeyFor(provider: CloudProviderId): string {
  return SECRET_KEYS[provider];
}
