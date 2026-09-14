import { describe, expect, it } from 'vitest';
import { DefaultDenyGate } from '../src/index.ts';

describe('DefaultDenyGate', () => {
  it('denies dangerous scopes by default', () => {
    const gate = new DefaultDenyGate();
    expect(gate.evaluate('shell.execute')).toBe('DENY');
    expect(gate.evaluate('device.control')).toBe('DENY');
    expect(gate.evaluate('deployment.promote')).toBe('DENY');
    expect(gate.evaluate('filesystem.read')).toBe('DENY');
    expect(() => gate.assertAllowed('secrets.use')).toThrow(/Permission denied/);
  });

  it('allows only after an explicit grant', () => {
    const gate = new DefaultDenyGate();
    gate.grant('filesystem.read', 'proj_1');
    expect(gate.evaluate('filesystem.read', 'proj_1')).toBe('ALLOW');
    expect(gate.evaluate('filesystem.read', 'proj_2')).toBe('DENY');
    expect(gate.evaluate('filesystem.write', 'proj_1')).toBe('DENY');
  });
});
