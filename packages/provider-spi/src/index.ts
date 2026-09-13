/** Broker-only. Dungeons and Nexus must not import this package. */

export type ProviderErrorKind =
  | "timeout"
  | "unavailable"
  | "abrupt_end"
  | "invalid_request"
  | "context_length"
  | "cancelled"
  | "permission_denied"
  | "billing";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly routingSignal: boolean;

  constructor(kind: ProviderErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.retryable = kind === "timeout" || kind === "unavailable" || kind === "abrupt_end";
    this.routingSignal = kind === "billing";
  }
}

export interface ProviderAdapter {
  readonly id: string;
  complete(prompt: string): AsyncIterable<string>;
}

export type HealthState = "healthy" | "configured" | "authentication_failure" | "unavailable";

export interface ProviderRegistry {
  canServe(providerId: string, capabilityId: string): { ok: boolean; state: HealthState; reason: string };
}
