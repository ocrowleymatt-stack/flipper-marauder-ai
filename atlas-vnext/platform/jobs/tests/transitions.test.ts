import { describe, expect, it } from 'vitest';
import { assertJobTransition } from '../src/index.ts';

describe('job state machine', () => {
  it('allows queued → running → completed', () => {
    expect(() => assertJobTransition('queued', 'running')).not.toThrow();
    expect(() => assertJobTransition('running', 'completed')).not.toThrow();
  });

  it('allows waiting and paused side states', () => {
    expect(() => assertJobTransition('running', 'waiting')).not.toThrow();
    expect(() => assertJobTransition('running', 'waiting_permission')).not.toThrow();
    expect(() => assertJobTransition('waiting', 'running')).not.toThrow();
    expect(() => assertJobTransition('paused', 'running')).not.toThrow();
  });

  it('rejects illegal transitions', () => {
    expect(() => assertJobTransition('completed', 'running')).toThrow(/Illegal job transition/);
    expect(() => assertJobTransition('cancelled', 'queued')).toThrow(/Illegal job transition/);
  });
});
