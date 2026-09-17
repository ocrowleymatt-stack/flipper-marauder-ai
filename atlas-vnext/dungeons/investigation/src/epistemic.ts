import type { EpistemicClass } from '@atlas-vnext/contracts';
import { InvestigationError } from './errors.ts';

export const EPISTEMIC_IMMUTABLE = 'epistemic_immutable';
export const EPISTEMIC_BOUNDARY = 'epistemic_boundary';

const FACT_FORBIDDEN_SOURCES: ReadonlySet<EpistemicClass> = new Set(['inference', 'hypothesis', 'contradiction']);

export function assertEpistemicClassImmutable(current: EpistemicClass, next: EpistemicClass): void {
  if (current !== next) {
    throw new InvestigationError(
      EPISTEMIC_IMMUTABLE,
      'Epistemic class cannot be changed. Record a new object with its own provenance.',
    );
  }
}

export function assertFactLineage(derivedFromClasses: readonly EpistemicClass[]): void {
  const forbidden = derivedFromClasses.filter((item) => FACT_FORBIDDEN_SOURCES.has(item));
  if (forbidden.length > 0) {
    throw new InvestigationError(
      EPISTEMIC_BOUNDARY,
      'A fact cannot be derived from an inference, hypothesis, or contradiction.',
    );
  }
}

export function assertFactProducer(producer: string): void {
  if (producer === 'model') {
    throw new InvestigationError(EPISTEMIC_BOUNDARY, 'A fact cannot be produced by a model.');
  }
}

export function kindToEpistemicClass(kind: string): EpistemicClass | null {
  if (kind === 'source_assertion' || kind === 'fact' || kind === 'inference' || kind === 'hypothesis' || kind === 'contradiction') {
    return kind;
  }
  return null;
}
