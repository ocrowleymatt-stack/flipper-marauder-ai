import { afterEach, describe, expect, it } from 'vitest';
import { GENERIC_DENY, PrivacyService } from '../src/index.ts';
import { closePersistence, openDungeonStack } from '../../../tests/helpers/dungeon-stack.ts';
import type { PlatformPersistence } from '@atlas-vnext/persistence';

const persistences: PlatformPersistence[] = [];

afterEach(async () => {
  while (persistences.length) {
    const item = persistences.pop();
    if (item) await closePersistence(item);
  }
});

describe('Privacy & Safety dungeon', () => {
  it('lets the owner inspect effective policy and requires CONFIRM for consequential updates', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const privacy = new PrivacyService({
      persistence: stack.persistence,
      authority: stack.authority,
      policy: stack.policy,
      ownerPrincipalId: stack.actor.principalId,
    });
    const viewed = await privacy.effective(stack.actor);
    expect(viewed.modelContext).not.toHaveProperty('secrets');
    expect(JSON.stringify(viewed.modelContext)).not.toMatch(/password|api[_-]?key/i);
    const explanation = await privacy.explain(stack.actor, {
      action: 'scan public source',
      capability: 'network.public',
      dungeonId: 'osint',
    });
    expect(explanation.authorityRule.length).toBeGreaterThan(0);
    await expect(
      privacy.update(stack.actor, { patch: { networkAccess: 'none' } }),
    ).rejects.toMatchObject({ code: 'step_up_required' });
    const updated = await privacy.update(stack.actor, {
      patch: { networkAccess: 'none' },
      confirm: 'CONFIRM',
    });
    expect(updated.networkAccess).toBe('none');
    const audit = await privacy.audit(stack.actor);
    expect(audit.some((row) => row.stepUp)).toBe(true);
  });

  it('rejects model self-grants and hides the control room from non-owners', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const privacy = new PrivacyService({
      persistence: stack.persistence,
      authority: stack.authority,
      policy: stack.policy,
      ownerPrincipalId: stack.actor.principalId,
    });
    await expect(
      privacy.update(stack.actor, { patch: { repoWrite: true }, proposedByModel: true, confirm: 'CONFIRM' }),
    ).rejects.toMatchObject({ httpStatus: 404, message: GENERIC_DENY });
    const intruder = { tenantId: 'tenant_a', principalId: 'principal_other', kind: 'user' as const };
    stack.authority.grantMembership(intruder.principalId, intruder.tenantId);
    stack.authority.grantTo({ principalId: intruder.principalId, tenantId: intruder.tenantId, capability: 'privacy.view' });
    stack.authority.grantTo({
      principalId: intruder.principalId,
      tenantId: intruder.tenantId,
      capability: 'privacy.configure',
    });
    await expect(privacy.effective(intruder)).rejects.toMatchObject({ httpStatus: 404, message: GENERIC_DENY });
    await expect(
      privacy.update(intruder, { patch: { autonomyCeiling: 'act' }, confirm: 'CONFIRM' }),
    ).rejects.toMatchObject({ httpStatus: 404, message: GENERIC_DENY });
    const proposal = await privacy.propose(intruder, { patch: { telemetry: 'off' } });
    expect(proposal.status).toBe('proposed');
    const denied = await privacy.decideProposal(stack.actor, proposal.id, 'denied');
    expect(denied.status).toBe('denied');
  });

  it('exposes stored overlays for host enforcement without making the control room public', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const privacy = new PrivacyService({
      persistence: stack.persistence,
      authority: stack.authority,
      policy: stack.policy,
      ownerPrincipalId: stack.actor.principalId,
    });
    await privacy.update(stack.actor, {
      patch: { toolsEnabled: false, processing: 'local_only' },
      confirm: 'CONFIRM',
    });
    const intruder = { tenantId: 'tenant_a', principalId: 'principal_other', kind: 'user' as const };
    const overlay = await privacy.runtimeOverlay(intruder);
    expect(overlay.toolsEnabled).toBe(false);
    expect(privacy.toolsAllowed(overlay, true)).toBe(false);
    expect(privacy.runtimePrivacy(overlay, 'any')).toBe('local_only');
    expect(privacy.scopedModelInstructions(overlay)).toMatch(/localOnly=true/);
    await expect(privacy.effective(intruder)).rejects.toMatchObject({ httpStatus: 404, message: GENERIC_DENY });
  });
});
