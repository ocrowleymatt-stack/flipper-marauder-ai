import { describe, expect, it } from 'vitest';
import { logPlatform, redactFields } from '../src/index.ts';

describe('observability redaction', () => {
  it('does not log prompt, file, or secret bodies', () => {
    const lines: string[] = [];
    logPlatform(
      'tool.succeeded',
      {
        prompt: 'SECRET PROMPT',
        content: 'file body',
        apiKey: 'sk-live-secret-value',
        tenantId: 'tenant_a',
        toolId: 'retrieval.search',
      },
      'info',
      (line) => lines.push(line),
    );
    expect(lines[0]).not.toContain('SECRET PROMPT');
    expect(lines[0]).not.toContain('file body');
    expect(lines[0]).not.toContain('sk-live-secret-value');
    expect(lines[0]).toContain('tenant_a');
    expect(redactFields({ authorization: 'Bearer abc' }).authorization).toBe('[redacted]');
    expect(redactFields({ cookie: 'atlas_session=ses_secret' }).cookie).toBe('[redacted]');
  });
});
