import { describe, expect, it } from 'vitest';
import { AuthorityEngine, EffectivePolicyEngine } from '../src/index.ts';
import { defaultEffectivePolicy } from '@atlas-vnext/contracts';

describe('EffectivePolicyEngine', () => {
  it('does not grant Authority and overlays cannot widen tenant restrictions', () => {
    const authority = new AuthorityEngine();
    const engine = new EffectivePolicyEngine(authority);
    const principal = { principalId: 'user_a', kind: 'user' as const, tenantId: 'tenant_a' };
    const tenant = engine.parse('tenant_a', null, {
      ...defaultEffectivePolicy('tenant_a'),
      networkAccess: 'none',
      autonomyCeiling: 'assist',
    });
    const dungeon = engine.parse('tenant_a', 'osint', {
      ...defaultEffectivePolicy('tenant_a', 'osint'),
      networkAccess: 'private',
      autonomyCeiling: 'act',
    });
    const overlay = engine.overlay(tenant, dungeon);
    expect(overlay.networkAccess).toBe('none');
    expect(overlay.autonomyCeiling).toBe('assist');
    const denied = engine.authorize({
      principal,
      capability: 'network.public',
      policy: overlay,
    });
    expect(denied.allowed).toBe(false);
    expect(['capability_missing', 'not_a_member']).toContain(denied.reasonCode);
  });

  it('policy can deny an Authority-allowed action without leaking', () => {
    const authority = new AuthorityEngine();
    authority.grantMembership('user_a', 'tenant_a');
    authority.grantTo({ principalId: 'user_a', tenantId: 'tenant_a', capability: 'network.public' });
    const engine = new EffectivePolicyEngine(authority);
    const policy = engine.parse('tenant_a', null, { ...defaultEffectivePolicy('tenant_a'), networkAccess: 'none' });
    const decision = engine.authorize({
      principal: { principalId: 'user_a', kind: 'user', tenantId: 'tenant_a' },
      capability: 'network.public',
      policy,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('policy_denied');
    expect(decision.authorityRule).toContain('ALLOW');
    expect(engine.modelContext(policy)).not.toHaveProperty('secrets');
    expect(JSON.stringify(engine.modelContext(policy))).not.toMatch(/password|api[_-]?key/i);
  });

  it('treats self-grant patches as consequential and detectable', () => {
    const engine = new EffectivePolicyEngine(new AuthorityEngine());
    expect(engine.selfGrantAttempt({ autonomyCeiling: 'act' })).toBe(true);
    expect(engine.selfGrantAttempt({ retrievalScope: 'selected_files' })).toBe(false);
    const before = engine.parse('tenant_a', null, defaultEffectivePolicy('tenant_a'));
    const after = engine.parse('tenant_a', null, { ...defaultEffectivePolicy('tenant_a'), repoWrite: true });
    expect(engine.isConsequential(before, after)).toBe(true);
  });
});
