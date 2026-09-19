import { describe, expect, it } from 'vitest';
import { citationsFromBackend, isProjectsUnavailable, mutatingHeaders, runtimeWaitingLabel, setCsrfToken } from './api';
import { applyStream, approvalAuthorityLine, conversationDisplayTitle, doctorTone, ellipsize, emptyView, executionToStop, liveExecution, runStatusLabel, viewFromSnapshot, visibleAssistantText } from './stream';
import type { ConversationSnapshot, ExecutionRecord } from './api';

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
    const unavailable = Object.assign(new Error('Projects require platform persistence.'), { status: 503 });
    expect(isProjectsUnavailable(unavailable)).toBe(true);
    expect(isProjectsUnavailable(new Error('no'))).toBe(false);
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
    expect(runStatusLabel('failed', false)).toBe('Failed');
    expect(runStatusLabel('running', true)).toBe('Waiting for approval');

    const nextExecution: ExecutionRecord = {
      id: 'ex_2',
      status: 'running',
      capability: 'nexus/fast',
      selectedProvider: 'openai',
      selectedModel: 'gpt-4o',
      attempts: [],
      usage: null,
      failureReason: null,
      route: null,
    };
    const unsealed = applyStream(view, 'con_1', { type: 'execution', execution: nextExecution }, runtimeWaitingLabel);
    expect(unsealed.sealedResponse).toBe(false);
    const withMessage = applyStream(
      unsealed,
      'con_1',
      {
        type: 'message',
        message: {
          id: 'msg_b',
          urn: 'u',
          conversationId: 'con_1',
          role: 'assistant',
          content: '',
          sequence: 2,
          executionId: 'ex_2',
          createdAt: 't',
          updatedAt: 't',
        },
      },
      runtimeWaitingLabel,
    );
    const live = applyStream(
      withMessage,
      'con_1',
      { type: 'message.delta', messageId: 'msg_b', content: 'fresh ' },
      runtimeWaitingLabel,
    );
    const assembled = applyStream(
      live,
      'con_1',
      { type: 'message.delta', messageId: 'msg_b', content: 'turn' },
      runtimeWaitingLabel,
    );
    expect(assembled.snapshot.messages.find((item) => item.id === 'msg_b')?.content).toBe('fresh turn');
  });

  it('seals only the latest failed execution when hydrating a snapshot', () => {
    const conversation: ConversationSnapshot['conversation'] = {
      id: 'con_1',
      urn: 'urn:atlas:conversation:con_1',
      title: 't',
      projectId: 'proj_1',
      createdAt: 't',
      updatedAt: 't',
    };
    const historicalFail: ExecutionRecord = {
      id: 'ex_old',
      status: 'failed',
      capability: 'nexus/fast',
      selectedProvider: 'openai',
      selectedModel: 'gpt-4o',
      attempts: [
        {
          index: 0,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'failed',
          emittedVisibleOutput: true,
          error: { code: 'cut', message: 'cut' },
        },
      ],
      usage: null,
      failureReason: { code: 'cut', message: 'cut' },
      route: null,
    };
    const latest: ExecutionRecord = {
      id: 'ex_new',
      status: 'completed',
      capability: 'nexus/fast',
      selectedProvider: 'openai',
      selectedModel: 'gpt-4o',
      attempts: [
        {
          index: 0,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'completed',
          emittedVisibleOutput: true,
          error: null,
        },
      ],
      usage: null,
      failureReason: null,
      route: null,
    };
    const view = viewFromSnapshot({
      conversation,
      messages: [],
      executions: [historicalFail, latest],
    });
    expect(view.sealedResponse).toBe(false);
    expect(view.classifiedFailure).toBeNull();
  });
});

describe('workbench presentation', () => {
  it('keeps sound off by default and never treats motion as the only state channel', async () => {
    const { playCue, prefersReducedMotion, setSoundEnabled, soundEnabled } = await import('./experience');
    expect(soundEnabled()).toBe(false);
    expect(typeof prefersReducedMotion()).toBe('boolean');
    setSoundEnabled(true);
    expect(soundEnabled()).toBe(true);
    setSoundEnabled(false);
    expect(soundEnabled()).toBe(false);
    playCue('complete');
    playCue('warn');
  });
});

describe('visible output recovery', () => {
  const conversation = {
    id: 'con_1',
    urn: 'urn:atlas:conversation:con_1',
    title: 't',
    projectId: 'proj_1',
    createdAt: 't',
    updatedAt: 't',
  };

  it('assembles assistant.delta even when no message envelope arrived yet', () => {
    let view = emptyView(conversation);
    view = applyStream(view, 'con_1', { type: 'assistant.delta', text: 'ATLAS ' }, () => null);
    view = applyStream(view, 'con_1', { type: 'assistant.delta', text: 'OUTPUT VISIBLE' }, () => null);
    expect(visibleAssistantText(view.snapshot.messages)).toContain('ATLAS OUTPUT VISIBLE');
  });

  it('creates an assistant message from message.delta when the id is new', () => {
    let view = emptyView(conversation);
    view = applyStream(
      view,
      'con_1',
      { type: 'message.delta', messageId: 'msg_new', content: 'hello from atlas' },
      () => null,
    );
    expect(view.snapshot.messages.some((item) => item.id === 'msg_new' && item.content === 'hello from atlas')).toBe(true);
  });

  it('assembles paired assistant.delta and message.delta without doubling', () => {
    let view = emptyView(conversation);
    view = applyStream(view, 'con_1', { type: 'message', message: {
      id: 'msg_a', urn: 'u', conversationId: 'con_1', role: 'assistant', content: '', sequence: 1, executionId: 'ex_1', createdAt: 't', updatedAt: 't',
    } }, () => null);
    view = applyStream(view, 'con_1', { type: 'assistant.delta', text: 'ATLAS ' }, () => null);
    view = applyStream(view, 'con_1', { type: 'message.delta', messageId: 'msg_a', content: 'ATLAS ' }, () => null);
    view = applyStream(view, 'con_1', { type: 'assistant.delta', text: 'OUTPUT VISIBLE' }, () => null);
    view = applyStream(view, 'con_1', { type: 'message.delta', messageId: 'msg_a', content: 'OUTPUT VISIBLE' }, () => null);
    expect(visibleAssistantText(view.snapshot.messages)).toBe('ATLAS OUTPUT VISIBLE');
  });

  it('keeps identical consecutive tokens when they are real model chunks', () => {
    let view = emptyView(conversation);
    view = applyStream(view, 'con_1', { type: 'message.delta', messageId: 'msg_a', content: 'la' }, () => null);
    view = applyStream(view, 'con_1', { type: 'assistant.delta', text: 'la' }, () => null);
    view = applyStream(view, 'con_1', { type: 'message.delta', messageId: 'msg_a', content: 'la' }, () => null);
    view = applyStream(view, 'con_1', { type: 'assistant.delta', text: 'la' }, () => null);
    expect(visibleAssistantText(view.snapshot.messages)).toBe('lala');
  });

  it('does not wipe streamed text when an empty placeholder message arrives later', () => {
    let view = emptyView(conversation);
    view = applyStream(view, 'con_1', { type: 'message.delta', messageId: 'msg_a', content: 'visible output' }, () => null);
    view = applyStream(view, 'con_1', { type: 'message', message: {
      id: 'msg_a', urn: 'u', conversationId: 'con_1', role: 'assistant', content: '', sequence: 1, executionId: 'ex_1', createdAt: 't', updatedAt: 't',
    } }, () => null);
    expect(visibleAssistantText(view.snapshot.messages)).toBe('visible output');
  });

  it('stops the live snapshot execution, not a completed inspection', () => {
    const previous: ExecutionRecord = {
      id: 'ex_old',
      status: 'completed',
      capability: 'nexus/fast',
      selectedProvider: 'openai',
      selectedModel: 'gpt-4o',
      attempts: [],
      usage: null,
      failureReason: null,
      route: null,
    };
    const current: ExecutionRecord = {
      ...previous,
      id: 'ex_live',
      status: 'running',
    };
    expect(liveExecution(true, current, previous)?.id).toBe('ex_live');
    expect(executionToStop(true, current)?.id).toBe('ex_live');
    expect(executionToStop(true, previous)).toBeNull();
    expect(executionToStop(false, current)).toBeNull();
  });

  it('replaces optimistic user turns when the server message arrives', () => {
    let view = emptyView(conversation);
    view = {
      ...view,
      snapshot: {
        ...view.snapshot,
        messages: [
          {
            id: 'local_user_1',
            urn: '',
            conversationId: 'con_1',
            role: 'user',
            content: 'hi',
            sequence: 1,
            executionId: null,
            createdAt: 't',
            updatedAt: 't',
          },
        ],
      },
    };
    view = applyStream(
      view,
      'con_1',
      {
        type: 'message',
        message: {
          id: 'msg_user',
          urn: 'u',
          conversationId: 'con_1',
          role: 'user',
          content: 'hi',
          sequence: 1,
          executionId: null,
          createdAt: 't',
          updatedAt: 't',
        },
      },
      () => null,
    );
    expect(view.snapshot.messages.map((item) => item.id)).toEqual(['msg_user']);
  });

  it('keeps conversation titles from colliding with metadata', () => {
    expect(ellipsize('OSINT ocrowley.matt@gmail.com and a very long remainder of the title', 24).endsWith('…')).toBe(true);
    expect(ellipsize('OSINT ocrowley.matt@gmail.com and a very long remainder of the title', 24).length).toBe(24);
    expect(conversationDisplayTitle('New conversation')).toBe('New conversation');
    expect(conversationDisplayTitle('OSINT matthew')).toBe('OSINT matthew');
  });

  it('does not call optional Ollama trouble a broken Atlas', () => {
    expect(doctorTone('ATTENTION_REQUIRED', [{ id: 'providers', state: 'error' }]).label).toBe('Attention');
    expect(doctorTone('ok', [{ id: 'providers', state: 'ok' }]).label).toBe('Healthy');
    expect(doctorTone('failed', [{ id: 'postgres', state: 'error' }]).label).toBe('Problem');
  });

  it('keeps machine-authoritative tool identity on the approval card', () => {
    expect(
      approvalAuthorityLine({
        risk: 'admin',
        sideEffectClass: 'shell',
        requiredCapabilities: ['shell.execute'],
      }),
    ).toBe('Risk admin · shell · Authority shell.execute');
    expect(
      approvalAuthorityLine({
        risk: 'read',
        sideEffectClass: 'none',
        requiredCapabilities: [],
      }),
    ).toBe('Risk read · none · Authority none');
  });
});
