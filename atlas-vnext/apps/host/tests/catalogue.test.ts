import { describe, expect, it } from 'vitest';
import { MODEL_CATALOGUE } from '../src/catalogue.ts';

describe('declarative model catalogue', () => {
  it('aliases grok-build to grok-build-0.1 with documented xAI capabilities', () => {
    const grokBuild = MODEL_CATALOGUE.find((row) => row.model === 'grok-build' && row.provider === 'xai');
    expect(grokBuild).toBeDefined();
    expect(grokBuild?.upstreamId).toBe('grok-build-0.1');
    // docs.x.ai/developers/models/grok-code-fast-1: text+image input, function calling,
    // structured outputs, reasoning, agentic coding. Catalogue model id is unchanged.
    expect(grokBuild?.capabilities).toEqual({
      text: true,
      reasoning: true,
      tools: true,
      vision: true,
      code: true,
    });
    expect(grokBuild?.contextWindow).toBe(256_000);
  });
});
