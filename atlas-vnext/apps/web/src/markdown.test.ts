import { describe, expect, it } from 'vitest';
import { MarkdownBody, safeMarkdownHref } from './markdown';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

describe('markdown body', () => {
  it('renders code, lists and links without HTML injection', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        text: 'Hello **Atlas**\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n\n[docs](https://atlas.ocrowley.com)\n\n<script>alert(1)</script>',
      }),
    );
    expect(html).toContain('<strong>Atlas</strong>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('const x = 1;');
    expect(html).toContain('href="https://atlas.ocrowley.com"');
    expect(html).toContain('script');
    expect(html).not.toMatch(/<script>/);
  });

  it('rejects protocol-relative and script URLs in markdown links', () => {
    expect(safeMarkdownHref('https://atlas.ocrowley.com')).toBe('https://atlas.ocrowley.com');
    expect(safeMarkdownHref('/projects/harbour')).toBe('/projects/harbour');
    expect(safeMarkdownHref('#notes')).toBe('#notes');
    expect(safeMarkdownHref('mailto:ops@atlas.ocrowley.com')).toBe('mailto:ops@atlas.ocrowley.com');
    expect(safeMarkdownHref('//attacker.com/phish')).toBe('#');
    expect(safeMarkdownHref('javascript:alert(1)')).toBe('#');
    expect(safeMarkdownHref('data:text/html,hi')).toBe('#');
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        text: '[phish](//attacker.com/page) [ok](/local)',
      }),
    );
    expect(html).toContain('href="#"');
    expect(html).toContain('href="/local"');
    expect(html).not.toContain('attacker.com');
  });
});
