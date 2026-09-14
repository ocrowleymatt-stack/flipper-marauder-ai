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

  register(model: RegisteredModel | unknown): RegisteredModel {
    const parsed = registeredModelSchema.parse(model);
    this.models.set(modelKey(parsed.provider, parsed.model), parsed);
    return parsed;
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
