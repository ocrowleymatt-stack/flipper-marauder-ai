import type { ProviderHealth, RegisteredModel } from '@atlas-vnext/contracts';

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * Declarative provider/model catalogue.
 * Health is recorded here; probing/transport is NOT this package's job.
 */
export class NexusRegistry {
  private readonly models = new Map<string, RegisteredModel>();

  register(model: RegisteredModel): void {
    this.models.set(modelKey(model.provider, model.model), model);
  }

  unregister(provider: string, model: string): void {
    this.models.delete(modelKey(provider, model));
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
    return model.health === 'healthy' || model.health === 'configured';
  }
}
