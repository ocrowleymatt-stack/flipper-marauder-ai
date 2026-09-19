import { describe, expect, it } from 'vitest';
import { MarkdownBody } from './markdown';
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
});
