import {
  registeredModelSchema,
  type ProviderHealth,
  type RegisteredModel,
} from '@atlas-vnext/contracts';

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * Declarative provider/model catalogue.
 * Health is recorded here; probing/transport is NOT this package's job.
 *
 * Adding or changing a model is a registry/configuration change, not a
 * router-source change. Malformed metadata is rejected at this boundary.
 */
export class NexusRegistry {
  private readonly models = new Map<string, RegisteredModel>();
  /** Operator kill list. Observed health may still be recorded; these stay non-routable. */
  private readonly disabledProviders = new Set<string>();

  register(model: RegisteredModel | unknown): RegisteredModel {
    const parsed = registeredModelSchema.parse(model);
    this.models.set(modelKey(parsed.provider, parsed.model), parsed);
    return parsed;
  }

  unregister(provider: string, model: string): void {
    this.models.delete(modelKey(provider, model));
  }

  /**
   * Replace the administrative disable list. Health probes may still call
   * `setHealth`; `isRoutable` stays false until this list is changed.
   */
  setDisabledProviders(providers: readonly string[]): void {
    this.disabledProviders.clear();
    for (const provider of providers) {
      const id = provider.trim().toLowerCase();
      if (id) this.disabledProviders.add(id);
    }
  }

  isDisabled(provider: string): boolean {
    return this.disabledProviders.has(provider.trim().toLowerCase());
  }

  setHealth(provider: string, health: ProviderHealth): void {
    for (const [key, model] of this.models) {
      if (model.provider === provider) {
        this.models.set(key, { ...model, health });
      }
    }
  }

  get(provider: string, model: string): RegisteredModel | undefined {
    return this.models.get(modelKey(provider, model));
  }

  list(): RegisteredModel[] {
    return [...this.models.values()];
  }

  isRoutable(model: RegisteredModel): boolean {
    if (this.isDisabled(model.provider)) return false;
    return model.health === 'healthy' || model.health === 'configured';
  }
}
