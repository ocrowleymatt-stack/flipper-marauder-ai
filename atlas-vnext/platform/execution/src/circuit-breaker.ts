/**
 * Circuit breaker for provider transport. Lives in the execution layer,
 * not in Nexus routing policy.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold = 3,
    private readonly resetTimeoutMs = 60_000,
  ) {}

  isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.openedAt > this.resetTimeoutMs) {
      this.failures = 0;
      return false;
    }
    return true;
  }

  success(): void {
    this.failures = 0;
  }

  failure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openedAt = Date.now();
    }
  }
}
