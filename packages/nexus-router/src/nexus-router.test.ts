import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  NexusAuthGateway,
  NexusRouter,
  TokenBucketRateLimiter,
  type IProviderAdapter,
} from './index.js';
import type { AiProviderType, ProviderCallResult } from '@atlas/core-contracts';

test('NexusAuthGateway validates reverse proxy secret and API tokens', () => {
  const gateway = new NexusAuthGateway({
    proxySharedSecret: 'secret_proxy_key_123',
    allowedOpsGroups: ['admin'],
  });

  // Valid proxy headers
  const user = gateway.verifyProxyIdentity('secret_proxy_key_123', 'usr-42', 'admin@atlas.local', 'admin|engineers');
  assert.ok(user !== null);
  assert.equal(user?.id, 'usr-42');
  assert.ok(user?.roles.includes('operator'));

  // Invalid proxy header
  const badProxy = gateway.verifyProxyIdentity('wrong_secret', 'usr-42', 'admin@atlas.local');
  assert.equal(badProxy, null);

  // API Token verification
  const rawToken = 'ak_prod_998877665544332211';
  const storedHash = createHash('sha256').update(rawToken).digest('hex');

  assert.equal(gateway.verifyApiToken(rawToken, storedHash), true);
  assert.equal(gateway.verifyApiToken('ak_prod_wrongsecret', storedHash), false);
  assert.equal(gateway.verifyApiToken('invalid_prefix_token', storedHash), false);
});

test('TokenBucketRateLimiter correctly throttles and refills', () => {
  const limiter = new TokenBucketRateLimiter(2, 10);
  assert.equal(limiter.tryConsume('client-ip-1'), true);
  assert.equal(limiter.tryConsume('client-ip-1'), true);
  assert.equal(limiter.tryConsume('client-ip-1'), false); // Capacity reached
});

test('NexusRouter fails over across providers and opens circuit breaker on repeated failure', async () => {
  const router = new NexusRouter();

  const mockHost: IProviderAdapter = {
    provider: 'host',
    isAvailable: async () => true,
    call: async () => {
      throw new Error('Host timeout');
    },
  };

  const mockGemini: IProviderAdapter = {
    provider: 'gemini',
    isAvailable: async () => true,
    call: async (prompt) => ({
      text: `Gemini response to: ${prompt}`,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      latencyMs: 120,
    }),
  };

  router.registerProvider(mockHost);
  router.registerProvider(mockGemini);

  const res = await router.routePrompt('Hello Atlas', { primaryProvider: 'host', fallbackAllowed: true });
  assert.equal(res.provider, 'gemini');
  assert.match(res.text, /Gemini response to: Hello Atlas/);
});
