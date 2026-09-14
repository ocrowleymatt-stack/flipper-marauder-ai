import { describe, expect, it } from 'vitest';
import { runtimeWaitingLabel } from './api';

describe('runtime waiting label', () => {
  it('shows GPU runtime starting instead of a broken empty reply', () => {
    expect(runtimeWaitingLabel('Job waiting_runtime for the shared RunPod.')).toBe('GPU runtime starting');
    expect(runtimeWaitingLabel('GPU runtime starting')).toBe('GPU runtime starting');
    expect(runtimeWaitingLabel('Waiting for the shared GPU')).toBe('Waiting for the shared GPU');
    expect(runtimeWaitingLabel(null)).toBeNull();
  });
});
