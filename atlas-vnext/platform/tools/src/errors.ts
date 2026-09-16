export class ToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class ToolValidationError extends ToolError {
  constructor(message: string) {
    super('invalid_arguments', message, false);
    this.name = 'ToolValidationError';
  }
}

export class UnknownToolError extends ToolError {
  constructor(toolId: string) {
    super('unknown_tool', `Fail-closed: unknown tool ${toolId}.`, false);
    this.name = 'UnknownToolError';
  }
}

export class IncompleteToolCallError extends ToolError {
  constructor() {
    super(
      'incomplete_tool_call',
      'Fail-closed: incomplete or fragmented tool calls must not execute.',
      false,
    );
    this.name = 'IncompleteToolCallError';
  }
}

export class DuplicateSideEffectError extends ToolError {
  constructor() {
    super('duplicate_side_effect', 'Fail-closed: refusing to repeat an uncertain external side effect.', false);
    this.name = 'DuplicateSideEffectError';
  }
}

export class ToolCancelUnconfirmedError extends ToolError {
  constructor() {
    super(
      'cancel_unconfirmed',
      'External stop is unconfirmed; invocation is not reported cancelled.',
      true,
    );
    this.name = 'ToolCancelUnconfirmedError';
  }
}

export function createAbortError(message = 'aborted'): Error {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  const message = err instanceof Error ? err.message : String(err);
  return name === 'AbortError' || message === 'aborted' || message === 'Execution aborted.';
}
