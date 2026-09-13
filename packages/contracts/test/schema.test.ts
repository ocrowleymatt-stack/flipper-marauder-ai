import { describe, expect, it } from 'vitest';

import {
  CONTRACTS_SCHEMA_VERSION,
  capabilityAliasSchema,
  defaultPermissionPolicy,
  jobSchema,
  objectIdSchema,
  permissionScopeSchema,
  providerRegistrySchema,
  routeRequestSchema,
} from '../src/index.js';

describe('contracts', () => {
  it('pins schema version 1', () => {
    expect(CONTRACTS_SCHEMA_VERSION).toBe(1);
  });

  it('accepts the closed permission scope list', () => {
    expect(permissionScopeSchema.options).toContain('device.control');
    expect(defaultPermissionPolicy['network.private']).toBe('deny');
  });

  it('parses a capability alias and explicit route request', () => {
    expect(capabilityAliasSchema.parse('nexus/cheap')).toBe('nexus/cheap');
    expect(
      routeRequestSchema.parse({
        schemaVersion: 1,
        alias: 'nexus/fast',
      }).alias,
    ).toBe('nexus/fast');
    expect(() => routeRequestSchema.parse({ schemaVersion: 1 })).toThrow();
  });

  it('parses a registry and a job skeleton', () => {
    const registry = providerRegistrySchema.parse({
      schemaVersion: 1,
      providers: [{ schemaVersion: 1, id: 'ollama', label: 'Ollama', locality: 'local', health: 'healthy' }],
      models: [
        {
          schemaVersion: 1,
          providerId: 'ollama',
          id: 'llama-local',
          label: 'Local Llama',
          capabilities: { text: true, reasoning: false, tools: true, vision: false, code: true },
          contextWindow: 8192,
          costClass: 'zero',
          latencyClass: 'medium',
          locality: 'local',
          health: 'healthy',
        },
      ],
    });
    expect(registry.models).toHaveLength(1);
    const id = objectIdSchema.parse('at_job_01234567-89ab-4def-8abc-0123456789ab');
    expect(
      jobSchema.parse({
        schemaVersion: 1,
        id,
        projectId: 'at_project_01234567-89ab-4def-8abc-0123456789ab',
        type: 'example.noop',
        status: 'queued',
        progress: { ratio: 0 },
        checkpoint: {},
        retry: { attempt: 0 },
        cancellation: {},
        traceId: 'trc-test',
        createdAt: '2026-09-13T00:00:00.000Z',
        updatedAt: '2026-09-13T00:00:00.000Z',
        createdBy: 'user-1',
      }).status,
    ).toBe('queued');
  });
});
