import { describe, expect, it } from 'vitest';
import { AuthorityEngine, authorityBoundary, behaviourGrantsNoAuthority, DefaultDenyGate } from '../src/index.ts';

describe('Authority', () => {
  it('Open and Standard expose identical Authority', () => {
    const gate = new AuthorityEngine();
    gate.grantMembership('user_a', 'tenant_a');
    gate.grantTo({ principalId: 'user_a', tenantId: 'tenant_a', capability: 'filesystem.read' });
    const principal = { principalId: 'user_a', kind: 'user' as const, tenantId: 'tenant_a' };
    const open = gate.decide({ principal, capability: 'shell.execute', behaviour: 'open' });
    const standard = gate.decide({ principal, capability: 'shell.execute', behaviour: 'standard' });
    expect(open.decision).toBe('DENY');
    expect(standard.decision).toBe('DENY');
    expect(behaviourGrantsNoAuthority('open', gate)).toBe(true);
    expect(authorityBoundary('open', gate).grantedScopes).toEqual(authorityBoundary('standard', gate).grantedScopes);
  });

  it('IDs are not authorisation and cross-tenant access fails closed without leaking', () => {
    const gate = new AuthorityEngine();
    gate.grantMembership('user_a', 'tenant_a');
    gate.grantTo({ principalId: 'user_a', tenantId: 'tenant_a', capability: 'file.read' });
    const verdict = gate.decide({
      principal: { principalId: 'user_a', kind: 'user', tenantId: 'tenant_a' },
      capability: 'file.read',
      resource: { type: 'file', id: 'file_b_guess', tenantId: 'tenant_b' },
    });
    expect(verdict.decision).toBe('DENY');
    expect(verdict.message).toBe('Permission denied.');
    expect(verdict.reasonCode).toBe('cross_tenant');
    expect(verdict.leakSensitive).toBe(false);
  });

  it('plugins cannot bypass missing capabilities', () => {
    const gate = new AuthorityEngine();
    gate.grantMembership('user_a', 'tenant_a');
    const verdict = gate.decide({
      principal: { principalId: 'user_a', kind: 'user', tenantId: 'tenant_a' },
      capability: 'shell.execute',
      fromPlugin: true,
      resource: { type: 'plugin', id: 'plugin.evil', tenantId: 'tenant_a' },
    });
    expect(verdict.decision).toBe('DENY');
    expect(verdict.reasonCode).toBe('plugin_cannot_bypass');
  });

  it('DefaultDenyGate still denies dangerous scopes until granted', () => {
    const gate = new DefaultDenyGate();
    expect(gate.evaluate('shell.execute')).toBe('DENY');
    gate.grant('tool.invoke.readonly');
    expect(gate.evaluate('tool.invoke.readonly')).toBe('ALLOW');
    expect(gate.evaluate('admin.configure')).toBe('DENY');
  });
});
