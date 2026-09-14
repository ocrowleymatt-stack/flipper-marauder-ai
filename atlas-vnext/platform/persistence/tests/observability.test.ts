import { describe, expect, it } from 'vitest';
import { logPlatform, redactFields, redactSecret } from '@atlas-vnext/observability';

describe('persistence observability redaction', () => {
  it('redacts database URLs, secrets, and message bodies', () => {
    expect(redactSecret('postgres://atlas:hunter2@db/atlas')).toBe('postgres://atlas:***@db/atlas');
    const fields = redactFields({
      database_url: 'postgres://atlas:hunter2@db/atlas',
      apiKey: 'sk-secret',
      content: 'user prompt body',
      payload: { text: 'nope' },
      jobId: 'job_1',
    });
    expect(fields.database_url).toBe('postgres://atlas:***@db/atlas');
    expect(fields.apiKey).toBe('[redacted]');
    expect(fields.content).toBe('[redacted]');
    expect(fields.payload).toBe('[redacted]');
    expect(fields.jobId).toBe('job_1');
    const lines: string[] = [];
    logPlatform('db.unavailable', { url: 'postgres://atlas:hunter2@127.0.0.1/atlas', content: 'hello' }, 'error', (line) =>
      lines.push(line),
    );
    expect(lines[0]).toContain('atlas:***@');
    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).not.toContain('hello');
  });
});
