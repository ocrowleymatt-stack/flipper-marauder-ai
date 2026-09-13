import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityPolicyEngine, TamperEvidentAuditLedger, type CapabilityRule } from './index.js';

test('CapabilityPolicyEngine enforces default-deny and deny-override', () => {
  const rules: CapabilityRule[] = [
    {
      id: 'allow-operator-read',
      description: 'Allow operators read capability',
      priority: 10,
      effect: 'allow',
      matches: (req) => req.roles.includes('operator') && req.action === 'read',
    },
    {
      id: 'deny-restricted-environment',
      description: 'Deny read on restricted resource in production',
      priority: 50,
      effect: 'deny',
      matches: (req) => req.environment === 'production' && req.resourceClassification === 'restricted',
    },
  ];

  const engine = new CapabilityPolicyEngine(rules);

  // 1. Unmatched request fails with default deny
  const unauth = engine.evaluate({
    actorId: 'user-1',
    roles: ['guest'],
    capability: 'system:read',
    action: 'read',
    environment: 'development',
  });
  assert.equal(unauth.allowed, false);
  assert.match(unauth.reason, /Default-deny/);

  // 2. Matching allow rule passes
  const allowed = engine.evaluate({
    actorId: 'user-2',
    roles: ['operator'],
    capability: 'system:read',
    action: 'read',
    environment: 'development',
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.decisiveRuleId, 'allow-operator-read');

  // 3. High-priority deny rule overrides matching allow
  const denied = engine.evaluate({
    actorId: 'user-2',
    roles: ['operator'],
    capability: 'system:read',
    action: 'read',
    environment: 'production',
    resourceClassification: 'restricted',
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.decisiveRuleId, 'deny-restricted-environment');
});

test('TamperEvidentAuditLedger maintains unbroken cryptographic hash chain', () => {
  const ledger = new TamperEvidentAuditLedger();
  ledger.append({
    actorId: 'admin',
    action: 'auth.login',
    resourceType: 'session',
    resourceId: 'sess-1',
    occurredAt: new Date().toISOString(),
  });
  ledger.append({
    actorId: 'admin',
    action: 'project.created',
    resourceType: 'project',
    resourceId: 'proj-1',
    occurredAt: new Date().toISOString(),
  });

  const check = ledger.verify();
  assert.equal(check.valid, true);
  assert.equal(check.totalEntries, 2);
});
