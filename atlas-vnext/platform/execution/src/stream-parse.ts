export interface SseFrame {
  event: string;
  data: string;
}

export async function* parseSse(stream: AsyncIterable<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const extracted = extractSse(buffer);
    buffer = extracted.rest;
    for (const frame of extracted.frames) yield frame;
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const extracted = extractSse(`${buffer}\n\n`);
    for (const frame of extracted.frames) yield frame;
  }
}

function extractSse(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalised = buffer.replace(/\r\n/g, '\n');
  const frames: SseFrame[] = [];
  let rest = normalised;
  while (true) {
    const split = rest.indexOf('\n\n');
    if (split === -1) break;
    const parsed = parseSseBlock(rest.slice(0, split));
    rest = rest.slice(split + 2);
    if (parsed) frames.push(parsed);
  }
  return { frames, rest };
}

function parseSseBlock(block: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

export async function* parseNdjson(stream: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const normalised = buffer.replace(/\r\n/g, '\n');
    const parts = normalised.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      yield JSON.parse(trimmed);
    }
  }
  buffer += decoder.decode();
  const trimmed = buffer.trim();
  if (trimmed) yield JSON.parse(trimmed);
}
