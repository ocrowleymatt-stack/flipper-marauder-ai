import { describe, expect, it } from 'vitest';
import { citationsFromBackend, mutatingHeaders, runtimeWaitingLabel, setCsrfToken } from './api';
import { applyStream, emptyView, runStatusLabel } from './stream';
import type { ConversationSnapshot } from './api';

describe('runtime waiting label', () => {
  it('shows GPU runtime starting instead of a broken empty reply', () => {
    expect(runtimeWaitingLabel('Job waiting_runtime for the shared RunPod.')).toBe('GPU runtime starting');
    expect(runtimeWaitingLabel('GPU runtime starting')).toBe('GPU runtime starting');
    expect(runtimeWaitingLabel('Waiting for the shared GPU')).toBe('Waiting for the shared GPU');
    expect(runtimeWaitingLabel(null)).toBeNull();
  });
});

describe('workbench client contracts', () => {
  it('sends CSRF on mutating requests and never puts a tenant picker in headers', () => {
    setCsrfToken('csrf-test');
    const headers = mutatingHeaders();
    expect(headers['x-atlas-csrf']).toBe('csrf-test');
    expect(headers['x-atlas-tenant']).toBeUndefined();
    expect(JSON.stringify(headers)).not.toMatch(/tenantId/);
  });

  it('only renders backend citations', () => {
    const citations = citationsFromBackend({
      slices: [],
      citations: [
        { chunkId: 'c1', fileId: 'f1', path: 'notes.md', locator: null, quote: 'hello', confidence: 'sourced' },
        { chunkId: null, fileId: null, path: null, locator: null, quote: null, confidence: 'unknown' },
      ],
      truncated: false,
      tokenCount: 1,
      tokenBudget: 100,
    });
    expect(citations).toHaveLength(2);
    expect(citations.every((item) => item.confidence === 'sourced' || item.confidence === 'unknown')).toBe(true);
  });

  it('does not treat a post-visible provider failure as a continuation of the same reply', () => {
    const conversation: ConversationSnapshot['conversation'] = {
      id: 'con_1',
      urn: 'urn:atlas:conversation:con_1',
      title: 't',
      projectId: 'proj_1',
      createdAt: 't',
      updatedAt: 't',
    };
    let view = emptyView(conversation);
    view = {
      ...view,
      snapshot: {
        ...view.snapshot,
        messages: [
          {
            id: 'msg_a',
            urn: 'u',
            conversationId: 'con_1',
            role: 'assistant',
            content: 'visible',
            sequence: 1,
            executionId: 'ex_1',
            createdAt: 't',
            updatedAt: 't',
          },
        ],
      },
    };
    view = applyStream(
      view,
      'con_1',
      { type: 'attempt.failed', failure: { message: 'cut' }, emittedVisibleOutput: true },
      runtimeWaitingLabel,
    );
    expect(view.sealedResponse).toBe(true);
    const continued = applyStream(
      view,
      'con_1',
      { type: 'message.delta', messageId: 'msg_a', content: 'visible then switched' },
      runtimeWaitingLabel,
    );
    expect(continued.snapshot.messages[0]?.content).toBe('visible');
    expect(runStatusLabel('failed', false)).toBe('failed');
    expect(runStatusLabel('running', true)).toBe('awaiting approval');
  });
});
