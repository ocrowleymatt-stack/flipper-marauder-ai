// Atlas vNext — Nexus contract test scaffold.
//
// Dependency-free executable specification of docs/NEXUS-CONTRACT.md.
// Runs with:  node --test tests/nexus-contract/
//
// Structure: PART A defines minimal in-file doubles (FakeRegistry, resolveIntent,
// executeWithFailover) that implement the contract semantics. PART B encodes the
// 12 acceptance cases against those doubles.
//
// Migration rule (see docs/MIGRATION-PLAN.md): implementation PRs replace the
// doubles with real modules (services/nexus, services/broker, provider SPI)
// WITHOUT changing case names or expectations. If a case needs to change, the
// contract document changes first.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// PART A — doubles (replace with real modules; keep the case expectations).
// ---------------------------------------------------------------------------

const HEALTHY = 'healthy';
const CONFIGURED = 'configured'; // credential present, liveness unproven: usable, not preferred
const AUTH_FAILURE = 'authentication_failure';
const UNAVAILABLE = 'unavailable';

function makeProvider(overrides = {}) {
  return {
    id: 'p',
    local: false,
    toolCapable: true,
    visionCapable: true,
    costPerK: 1,
    health: HEALTHY,
    ...overrides,
  };
}

// Initial capability table from docs/NEXUS-CONTRACT.md §2.
const CAPABILITIES = {
  'nexus/fast': { primary: 'owned', fallbacks: ['openai', 'ollama', 'anthropic', 'venice'] },
  'nexus/reason': { primary: 'anthropic', fallbacks: ['openai', 'owned', 'gemini', 'venice'] },
  'nexus/code': { primary: 'openai', fallbacks: ['owned', 'anthropic', 'venice', 'ollama'] },
  'nexus/vision': { primary: 'gemini', fallbacks: ['openai'], requiresVision: true },
  'nexus/research': { primary: 'openai', fallbacks: ['owned', 'anthropic', 'openrouter', 'gemini'], requiresTools: true },
  'nexus/deep': { primary: 'anthropic', fallbacks: ['openai', 'owned', 'venice', 'gemini', 'openrouter'], fanout: true },
  'nexus/private': { primary: 'ollama', fallbacks: [], localOnly: true },
  'nexus/cheapest': { primary: null, fallbacks: [], cheapest: true },
};

const ALIASES = { auto: 'nexus/fast', 'nexus/auto': 'nexus/fast' };

function usable(provider) {
  return provider.health === HEALTHY || provider.health === CONFIGURED;
}

function exclusionReason(provider) {
  if (provider.health === AUTH_FAILURE) return 'authentication-failure';
  if (provider.health === UNAVAILABLE) return 'not-configured';
  return 'unhealthy';
}

// Boot validation: every id in the table must resolve to a registered adapter
// (or be explicitly tolerated). Throws a NAMED error otherwise.
function validateChains(capabilities, registry) {
  for (const [alias, chain] of Object.entries(capabilities)) {
    if (chain.cheapest) continue;
    for (const id of [chain.primary, ...chain.fallbacks]) {
      if (!registry.has(id)) {
        throw Object.assign(new Error(`capability ${alias} references unregistered route: ${id}`), {
          code: 'unknown-route',
        });
      }
    }
    if (chain.localOnly && ![chain.primary, ...chain.fallbacks].some((id) => registry.get(id)?.local)) {
      throw Object.assign(new Error(`capability ${alias} has no local provider`), { code: 'empty-chain' });
    }
  }
}

// Pure resolution: (target, registrySnapshot) -> intent. No I/O.
function resolveIntent(target, registry, opts = {}) {
  const canonical = ALIASES[target] ?? target;
  const contextTokens = opts.contextTokens ?? 0;
  const budgetTokens = opts.budgetTokens ?? 128_000;
  if (contextTokens > budgetTokens) {
    throw Object.assign(
      new Error(`context exceeded budget by ${contextTokens - budgetTokens} tokens`),
      { code: 'context-exceeded', overBy: contextTokens - budgetTokens },
    );
  }
  // Explicit provider routing: named provider or named error, never substitution.
  if (canonical.startsWith('provider/')) {
    const id = canonical.slice('provider/'.length);
    const provider = registry.get(id);
    if (!provider) throw Object.assign(new Error(`unknown provider: ${id}`), { code: 'unknown-route' });
    if (!usable(provider)) {
      throw Object.assign(new Error(`provider ${id} unusable: ${exclusionReason(provider)}`), {
        code: 'provider-unavailable',
        reason: exclusionReason(provider),
      });
    }
    return { capability: null, chain: [id], attempted: [id], usedFallback: false, budgets: { budgetTokens } };
  }

  const chain = CAPABILITIES[canonical];
  if (!chain) {
    throw Object.assign(new Error(`unknown target: ${target}`), {
      code: 'unknown-target',
      validTargets: [...Object.keys(CAPABILITIES), ...Object.keys(ALIASES)],
    });
  }

  let ordered;
  if (chain.cheapest) {
    const priced = [...registry.values()].filter(usable);
    if (!priced.some((p) => p.costPerK !== undefined)) {
      // Degrade to fast order, recorded.
      const fast = CAPABILITIES['nexus/fast'];
      ordered = [fast.primary, ...fast.fallbacks].filter((id) => usable(registry.get(id)));
      return { capability: canonical, chain: ordered, attempted: ordered, usedFallback: false, degraded: 'no-cost-data' };
    }
    ordered = priced.sort((a, b) => a.costPerK - b.costPerK).map((p) => p.id);
  } else {
    ordered = [chain.primary, ...chain.fallbacks];
  }

  const attempted = [];
  const resolved = [];
  for (const id of ordered) {
    const provider = registry.get(id);
    // A missing provider inside a local-only chain means "no local capacity":
    // fail closed (constraint-violation via the empty-chain path below).
    // Anywhere else it is a registry integrity bug: named error.
    if (!provider) {
      if (chain.localOnly) continue;
      throw Object.assign(new Error(`unregistered route: ${id}`), { code: 'unknown-route' });
    }
    if (chain.localOnly && !provider.local) continue;
    if (chain.requiresVision && !provider.visionCapable) continue;
    if (chain.requiresTools && !provider.toolCapable) continue;
    if (!usable(provider)) {
      attempted.push({ id, excluded: exclusionReason(provider) });
      continue;
    }
    attempted.push({ id });
    resolved.push(id);
  }
  if (resolved.length === 0) {
    const err = new Error(
      chain.localOnly ? 'no local provider available' : `capability ${canonical} has no usable provider`,
    );
    err.code = chain.localOnly ? 'constraint-violation' : 'provider-unavailable';
    err.attempted = attempted;
    throw err;
  }
  return {
    capability: canonical,
    chain: resolved,
    attempted,
    usedFallback: resolved[0] !== chain.primary,
    budgets: { budgetTokens },
  };
}

const RETRYABLE = new Set(['timeout', 'unavailable', 'abrupt-end']);
const TERMINAL = new Set(['invalid-request', 'context-length', 'cancelled']);

// Failover simulator: runs a scripted provider chain. Each script entry is
// { chunks: [{text}|{tool}], failWith } where failWith fires after chunks.
// Enforces: bounded transient retries, terminal errors advance immediately,
// tool outputs buffered until success, NO switch after visible text.
function executeWithFailover(chain, scripts, opts = {}) {
  const maxTransientAttempts = opts.maxTransientAttempts ?? 2;
  const committed = []; // emitted visible text / executed tools
  const attemptedProviders = [];
  let lastError = null;

  for (const id of chain) {
    const script = scripts[id] ?? { chunks: [{ text: `answer from ${id}` }] };
    for (let attempt = 1; attempt <= maxTransientAttempts; attempt += 1) {
      attemptedProviders.push(id);
      let emittedVisibleText = false;
      const bufferedTools = [];
      try {
        for (const chunk of script.chunks) {
          if (chunk.tool) {
            bufferedTools.push(chunk.tool);
            continue;
          }
          if (chunk.text && chunk.text.length > 0) emittedVisibleText = true;
          committed.push({ provider: id, text: chunk.text });
        }
        if (script.failWith) throw script.failWith;
        // Commit buffered tool calls only on successful completion.
        for (const tool of bufferedTools) {
          if (!opts.registeredTools?.has(tool.name)) {
            throw Object.assign(new Error(`tool not found: ${tool.name}`), { code: 'tool-not-found' });
          }
          committed.push({ provider: id, executedTool: tool.name });
        }
        return { provider: id, committed, attemptedProviders };
      } catch (error) {
        if (emittedVisibleText) throw error; // NO double-answer: surface original failure.
        lastError = error;
        if (TERMINAL.has(error.kind)) break; // terminal: advance immediately.
        if (RETRYABLE.has(error.kind) && attempt < maxTransientAttempts) continue; // bounded retry.
        break; // non-retryable or budget spent: advance.
      }
    }
  }
  throw lastError ?? new Error('empty chain');
}

function healthyRegistry() {
  return new Map([
    ['owned', makeProvider({ id: 'owned', costPerK: 0.2 })],
    ['openai', makeProvider({ id: 'openai', costPerK: 1.0 })],
    ['anthropic', makeProvider({ id: 'anthropic', costPerK: 1.5 })],
    ['ollama', makeProvider({ id: 'ollama', local: true, costPerK: 0 })],
    ['venice', makeProvider({ id: 'venice', costPerK: 0.8 })],
    ['gemini', makeProvider({ id: 'gemini', costPerK: 0.5 })],
    ['openrouter', makeProvider({ id: 'openrouter', costPerK: 0.9 })],
  ]);
}

// ---------------------------------------------------------------------------
// PART B — the 12 contract cases.
// ---------------------------------------------------------------------------

describe('nexus contract', () => {
  it('case 1 — fast route leads with the owned pod when healthy', () => {
    const intent = resolveIntent('nexus/fast', healthyRegistry());
    assert.equal(intent.chain[0], 'owned');
    assert.equal(intent.usedFallback, false);
  });

  it('case 2 — reason route leads with anthropic + reasoning policy', () => {
    const intent = resolveIntent('nexus/reason', healthyRegistry());
    assert.equal(intent.chain[0], 'anthropic');
  });

  it('case 3 — code route leads with openai', () => {
    const intent = resolveIntent('nexus/code', healthyRegistry());
    assert.equal(intent.chain[0], 'openai');
  });

  it('case 4 — vision route rejects non-vision adapters at resolution', () => {
    const registry = healthyRegistry();
    registry.set('plain', makeProvider({ id: 'plain', visionCapable: false }));
    const intent = resolveIntent('nexus/vision', registry);
    assert.deepEqual(intent.chain, ['gemini', 'openai']);
    assert.ok(!intent.chain.includes('plain'));
  });

  it('case 5 — explicit provider routing: named provider or named error', () => {
    const ok = resolveIntent('provider/anthropic', healthyRegistry());
    assert.deepEqual(ok.chain, ['anthropic']);
    assert.throws(() => resolveIntent('provider/hetzner', healthyRegistry()), (e) => e.code === 'unknown-route');
    const down = healthyRegistry();
    down.set('anthropic', makeProvider({ id: 'anthropic', health: UNAVAILABLE }));
    assert.throws(() => resolveIntent('provider/anthropic', down), (e) => e.code === 'provider-unavailable');
  });

  it('case 6 — unhealthy primary is excluded with reason; fallback marked', () => {
    const registry = healthyRegistry();
    registry.set('owned', makeProvider({ id: 'owned', health: AUTH_FAILURE, costPerK: 0.2 }));
    const intent = resolveIntent('nexus/fast', registry);
    assert.equal(intent.chain[0], 'openai');
    assert.equal(intent.usedFallback, true);
    assert.ok(intent.attempted.some((a) => a.id === 'owned' && a.excluded === 'authentication-failure'));
  });

  it('case 7 — failover: retryable pre-output failure advances the chain', () => {
    const intent = resolveIntent('nexus/fast', healthyRegistry());
    const result = executeWithFailover(intent.chain, {
      owned: { chunks: [], failWith: Object.assign(new Error('boom'), { kind: 'timeout' }) },
      openai: { chunks: [{ text: 'recovered' }] },
    });
    assert.equal(result.provider, 'openai');
    assert.ok(result.attemptedProviders.includes('owned'));
    // terminal errors advance without consuming the retry budget
    const t = executeWithFailover(['a', 'b'], {
      a: { chunks: [], failWith: Object.assign(new Error('bad'), { kind: 'invalid-request' }) },
      b: { chunks: [{ text: 'ok' }] },
    });
    assert.deepEqual(t.attemptedProviders, ['a', 'b']);
  });

  it('case 8 — no double-answer: failure after visible text surfaces, no switch', () => {
    assert.throws(
      () =>
        executeWithFailover(['owned', 'openai'], {
          owned: {
            chunks: [{ text: 'partial answer…' }],
            failWith: Object.assign(new Error('died mid-stream'), { kind: 'timeout' }),
          },
          openai: { chunks: [{ text: 'second answer — must never emit' }] },
        }),
      (e) => e.message === 'died mid-stream',
    );
  });

  it('case 8b — uncommitted tool calls from a failed attempt are discarded', () => {
    const result = executeWithFailover(['owned', 'openai'], {
      owned: {
        chunks: [{ tool: { name: 'send-email' } }],
        failWith: Object.assign(new Error('died before commit'), { kind: 'unavailable' }),
      },
      openai: { chunks: [{ text: 'ok' }] },
    });
    assert.ok(!result.committed.some((c) => c.executedTool === 'send-email'));
  });

  it('case 9 — tool requirements: closed world for unknown tools', () => {
    const toolLess = healthyRegistry();
    toolLess.set('openai', makeProvider({ id: 'openai', toolCapable: false, costPerK: 1.0 }));
    const intent = resolveIntent('nexus/research', toolLess);
    assert.ok(!intent.chain.includes('openai'));
    assert.throws(
      () =>
        executeWithFailover(['x'], { x: { chunks: [{ tool: { name: 'nope.not-real' } }] } }, {
          registeredTools: new Set(['web.fetch']),
        }),
      (e) => e.code === 'tool-not-found',
    );
  });

  it('case 10 — context limits fail pre-spend with a shrinkage hint', () => {
    assert.throws(
      () => resolveIntent('nexus/fast', healthyRegistry(), { contextTokens: 200_000, budgetTokens: 128_000 }),
      (e) => e.code === 'context-exceeded' && e.overBy === 72_000,
    );
    const ok = resolveIntent('nexus/fast', healthyRegistry(), { contextTokens: 1000 });
    assert.equal(ok.budgets.budgetTokens, 128_000);
  });

  it('case 11 — local-only never escapes to cloud, even under failover', () => {
    const intent = resolveIntent('nexus/private', healthyRegistry());
    assert.deepEqual(intent.chain, ['ollama']);
    const noLocal = healthyRegistry();
    noLocal.delete('ollama');
    assert.throws(() => resolveIntent('nexus/private', noLocal), (e) => e.code === 'constraint-violation');
  });

  it('case 12 — cheapest orders by cost; degrades with a recorded reason', () => {
    const intent = resolveIntent('nexus/cheapest', healthyRegistry());
    const costs = intent.chain.map((id) => healthyRegistry().get(id).costPerK);
    assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
    const noCosts = new Map([...healthyRegistry().entries()].map(([k, p]) => [k, { ...p, costPerK: undefined }]));
    const degraded = resolveIntent('nexus/cheapest', noCosts);
    assert.equal(degraded.degraded, 'no-cost-data');
  });

  it('boot validation refuses unresolvable primaries (the hetzner/chat gap)', () => {
    const registry = healthyRegistry();
    registry.delete('owned');
    const broken = { 'nexus/fast': { primary: 'hetzner', fallbacks: [] } };
    assert.throws(() => validateChains(broken, registry), (e) => e.code === 'unknown-route');
    assert.doesNotThrow(() => validateChains(CAPABILITIES, healthyRegistry()));
  });
});
