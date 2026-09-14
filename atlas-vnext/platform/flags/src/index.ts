export interface FeatureFlagStore {
  enabled(flag: string, context?: { projectId?: string; dungeon?: string }): boolean;
}

export class FlagsNotImplementedError extends Error {
  constructor() {
    super('platform/flags persistence is deferred; the interface is the contract.');
    this.name = 'FlagsNotImplementedError';
  }
}
