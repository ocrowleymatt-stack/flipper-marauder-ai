import type { ReactNode } from 'react';

export function MarkdownBody({ text }: { text: string }) {
  if (!text) return null;
  const blocks = splitBlocks(text);
  return (
    <div className="md">
      {blocks.map((block, index) => (
        <Block key={`${block.kind}-${index}`} block={block} />
      ))}
    </div>
  );
}

type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'paragraph'; text: string };

function splitBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith('```')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code', lang, text: body.join('\n') });
      continue;
    }
    if (line.startsWith('> ')) {
      const body: string[] = [];
      while (index < lines.length && (lines[index]?.startsWith('> ') || lines[index] === '>')) {
        body.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (index < lines.length && (ordered ? /^\s*\d+\.\s+/.test(lines[index] ?? '') : /^\s*[-*]\s+/.test(lines[index] ?? ''))) {
        items.push((lines[index] ?? '').replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const body: string[] = [];
    while (index < lines.length && lines[index]?.trim() && !lines[index]?.startsWith('```') && !/^\s*[-*]\s+/.test(lines[index] ?? '') && !/^\s*\d+\.\s+/.test(lines[index] ?? '')) {
      body.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: body.join('\n') });
  }
  return blocks;
}

function Block({ block }: { block: Block }) {
  if (block.kind === 'code') {
    return (
      <pre className="md-code">
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.kind === 'quote') {
    return <blockquote className="md-quote">{inline(block.text)}</blockquote>;
  }
  if (block.kind === 'list') {
    const List = block.ordered ? 'ol' : 'ul';
    return (
      <List className="md-list">
        {block.items.map((item, index) => (
          <li key={index}>{inline(item)}</li>
        ))}
      </List>
    );
  }
  return <p>{inline(block.text)}</p>;
}

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('[')) {
      const label = token.slice(1, token.indexOf(']'));
      const href = token.slice(token.indexOf('(') + 1, -1);
      const safe = /^(https?:|mailto:|\/|#)/i.test(href) ? href : '#';
      nodes.push(
        <a key={key} href={safe} rel="noreferrer" target={safe.startsWith('http') ? '_blank' : undefined}>
          {label}
        </a>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    key += 1;
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
