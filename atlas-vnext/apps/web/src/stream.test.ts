import { describe, expect, it } from 'vitest';
import { runtimeWaitingLabel } from './api';
import type { ConversationSnapshot, Message, StreamEvent } from './api';
import { applyStream, emptyView, ensureView, userRunLabel } from './stream';

const conversation: ConversationSnapshot['conversation'] = {
  id: 'con_1',
  urn: 'urn:atlas:conversation:con_1',
  title: 't',
  projectId: 'proj_1',
  createdAt: 't',
  updatedAt: 't',
};

function assistant(partial: Partial<Message> = {}): Message {
  return {
    id: 'msg_a',
    urn: 'u',
    conversationId: 'con_1',
    role: 'assistant',
    content: '',
    sequence: 1,
    executionId: 'ex_1',
    createdAt: 't',
    updatedAt: 't',
    ...partial,
  };
}

function user(partial: Partial<Message> = {}): Message {
  return {
    id: 'msg_u',
    urn: 'u',
    conversationId: 'con_1',
    role: 'user',
    content: 'hello',
    sequence: 0,
    executionId: null,
    createdAt: 't',
    updatedAt: 't',
    ...partial,
  };
}

function play(events: StreamEvent[], start = emptyView(conversation)) {
  return events.reduce((view, event) => applyStream(view, 'con_1', event, runtimeWaitingLabel), start);
}

describe('visible output stream assembly', () => {
  it('assembles paired assistant.delta and message.delta without doubling', () => {
    const view = play([
      { type: 'message', message: user({ content: 'Reply with exactly: COPPER KETTLE VISIBLE OUTPUT' }) },
      { type: 'message', message: assistant({ content: '' }) },
      { type: 'assistant.delta', text: 'COP' },
      { type: 'message.delta', messageId: 'msg_a', content: 'COP' },
      { type: 'assistant.delta', text: 'PER' },
      { type: 'message.delta', messageId: 'msg_a', content: 'PER' },
      { type: 'assistant.delta', text: ' KETTLE VISIBLE OUTPUT' },
      { type: 'message.delta', messageId: 'msg_a', content: ' KETTLE VISIBLE OUTPUT' },
      { type: 'assistant.completed', text: 'COPPER KETTLE VISIBLE OUTPUT' },
    ]);
    expect(view.snapshot.messages.find((item) => item.role === 'assistant')?.content).toBe('COPPER KETTLE VISIBLE OUTPUT');
  });

  it('does not wipe streamed text when an empty placeholder message arrives later', () => {
    const streamed = play([
      { type: 'message', message: assistant({ content: '' }) },
      { type: 'assistant.delta', text: 'visible ' },
      { type: 'message.delta', messageId: 'msg_a', content: 'visible ' },
      { type: 'assistant.delta', text: 'output' },
      { type: 'message.delta', messageId: 'msg_a', content: 'output' },
    ]);
    expect(streamed.snapshot.messages[0]?.content).toBe('visible output');
    const wiped = applyStream(
      streamed,
      'con_1',
      { type: 'message', message: assistant({ content: '' }) },
      runtimeWaitingLabel,
    );
    expect(wiped.snapshot.messages[0]?.content).toBe('visible output');
  });

  it('creates an assistant turn from assistant.delta when the placeholder never arrived', () => {
    const view = play([
      { type: 'message', message: user() },
      { type: 'assistant.delta', text: 'hello ' },
      { type: 'assistant.delta', text: 'there' },
      { type: 'assistant.completed', text: 'hello there' },
    ]);
    const assistantMessage = view.snapshot.messages.find((item) => item.role === 'assistant');
    expect(assistantMessage?.content).toBe('hello there');
  });

  it('keeps identical consecutive tokens when they are real model chunks, not event pairs', () => {
    const view = play([
      { type: 'message', message: assistant({ content: '' }) },
      { type: 'assistant.delta', text: 'la' },
      { type: 'message.delta', messageId: 'msg_a', content: 'la' },
      { type: 'assistant.delta', text: 'la' },
      { type: 'message.delta', messageId: 'msg_a', content: 'la' },
    ]);
    expect(view.snapshot.messages[0]?.content).toBe('lala');
  });

  it('does not drop the first turn when the React view is still null', () => {
    const view = play(
      [
        { type: 'message', message: user({ content: 'first send' }) },
        { type: 'message', message: assistant({ content: '' }) },
        { type: 'assistant.delta', text: 'here' },
        { type: 'message.delta', messageId: 'msg_a', content: 'here' },
      ],
      ensureView(null, 'con_1', conversation),
    );
    expect(view.snapshot.messages.map((item) => item.content)).toEqual(['first send', 'here']);
  });

  it('surfaces classified failures without erasing already-visible text', () => {
    const view = play([
      { type: 'message', message: assistant({ content: 'partial' }) },
      {
        type: 'error',
        failure: { code: 'provider_failed', message: 'The provider failed.' },
      },
    ]);
    expect(view.classifiedFailure).toBe('The provider failed.');
    expect(view.snapshot.messages[0]?.content).toBe('partial');
    expect(userRunLabel('failed', false, false)).toBe('Failed');
  });
});
