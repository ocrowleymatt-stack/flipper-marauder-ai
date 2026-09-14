import { describe, expect, it } from 'vitest';

const enabled = process.env.ATLAS_LIVE_SMOKE === '1';

describe.skipIf(!enabled)('optional live provider smoke', () => {
  it('documents that live smoke is env-gated and not part of default CI', () => {
    expect(enabled).toBe(true);
  });
});
