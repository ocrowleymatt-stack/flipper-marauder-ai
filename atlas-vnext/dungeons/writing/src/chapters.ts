export interface DetectedChapter {
  title: string;
  order: number;
  wordCount: number;
  content: string;
}

export interface BoundChapter {
  title: string;
  order: number;
  wordCount: number;
  documentId?: string | null;
}

function wc(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function normaliseChapterTitle(raw: string, index: number, mode = 'novel'): string {
  const clean = raw
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\s*(chapter|section|part|book|scene)\s+/i, (match) => `${match.trim()} `)
    .replace(/\s+/g, ' ')
    .trim();
  if (clean) return clean.slice(0, 140);
  const noun =
    mode === 'nonfiction' || mode === 'essay' ? 'Section' : mode === 'script' || mode === 'musical' ? 'Scene' : 'Chapter';
  return `${noun} ${index + 1}`;
}

export function chapterIdentity(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

type Marker = { start: number; end: number; title: string; score: number };

function headingMarkers(text: string): Marker[] {
  const lines = text.split('\n');
  const starts: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    starts.push(cursor);
    cursor += line.length + 1;
  }

  const candidates: Marker[] = [];
  const special =
    /^(prologue|epilogue|introduction|preface|foreword|afterword|conclusion|interlude|acknowledg(?:e)?ments|appendix(?:\s+[A-Z0-9IVXLC]+)?)(?:\s*[:—-]\s*(.+))?$/i;
  const labelled =
    /^(chapter|section|part|book|scene)\s+([0-9]{1,4}|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?:\s*[:.—-]\s*(.+))?$/i;
  const numberedTitle = /^([0-9]{1,3}|[IVXLC]{1,8})[.)]\s+(.{2,100})$/;
  const markdown = /^#{1,3}\s+(.{1,140})$/;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const prevBlank = i === 0 || !lines[i - 1]!.trim();
    const nextBlank = i === lines.length - 1 || !lines[i + 1]!.trim();
    let title = '';
    let score = 0;
    const md = line.match(markdown);
    const lab = line.match(labelled);
    const sp = line.match(special);
    const num = line.match(numberedTitle);
    if (md) {
      title = md[1] ?? line;
      score = 10;
    } else if (lab) {
      title = line;
      score = 10;
    } else if (sp) {
      title = line;
      score = 10;
    } else if (num && prevBlank) {
      title = line;
      score = 8;
    } else {
      const allCaps =
        line.length >= 3 &&
        line.length <= 90 &&
        line === line.toUpperCase() &&
        /[A-Z]/.test(line) &&
        !/[.!?]$/.test(line);
      const titleCase =
        line.length >= 3 &&
        line.length <= 80 &&
        /^[A-Z][^.!?]{2,79}$/.test(line) &&
        line.split(/\s+/).length <= 10;
      if (prevBlank && nextBlank && allCaps) {
        title = line;
        score = 5;
      } else if (prevBlank && nextBlank && titleCase) {
        title = line;
        score = 3;
      }
    }
    if (title) candidates.push({ start: starts[i]!, end: starts[i]! + raw.length, title, score });
  });

  const strong = candidates.filter((item) => item.score >= 8);
  if (strong.length >= 2) return strong;
  const medium = candidates.filter((item) => item.score >= 5);
  if (medium.length >= 3) return medium;
  return candidates.filter((item) => item.score >= 3).length >= 4 ? candidates.filter((item) => item.score >= 3) : [];
}

export function detectChapters(text: string, mode = 'novel'): DetectedChapter[] {
  const source = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!source) return [];
  const markers = headingMarkers(source);
  if (markers.length < 2) {
    return [
      {
        title: normaliseChapterTitle('', 0, mode),
        order: 0,
        wordCount: wc(source),
        content: source,
      },
    ];
  }

  const chapters: DetectedChapter[] = [];
  const preamble = source.slice(0, markers[0]!.start).trim();
  if (wc(preamble) >= 80) {
    chapters.push({
      title: mode === 'nonfiction' || mode === 'essay' ? 'Opening / front matter' : 'Front matter',
      order: 0,
      wordCount: wc(preamble),
      content: preamble,
    });
  }

  markers.forEach((marker, i) => {
    const next = markers[i + 1];
    const body = source.slice(marker.end, next ? next.start : source.length).trim();
    if (wc(body) < 8 && i < markers.length - 1) return;
    chapters.push({
      title: normaliseChapterTitle(marker.title, chapters.length, mode),
      order: chapters.length,
      wordCount: wc(body),
      content: body,
    });
  });

  return chapters.length
    ? chapters
    : [
        {
          title: normaliseChapterTitle('', 0, mode),
          order: 0,
          wordCount: wc(source),
          content: source,
        },
      ];
}

export function bindStructureByTitle(
  detected: DetectedChapter[],
  previous: BoundChapter[] = [],
): BoundChapter[] {
  return detected.map((chapter, order) => {
    const prior = previous.find((item) => chapterIdentity(item.title) === chapterIdentity(chapter.title));
    return {
      title: chapter.title,
      order,
      wordCount: chapter.wordCount,
      documentId: prior?.documentId ?? null,
    };
  });
}

export function formatStructureForPrompt(chapters: BoundChapter[], budget = 800): string {
  if (!chapters.length) return '';
  const lines = ['Chapter structure (bound by title, not index):'];
  for (const chapter of chapters) {
    const line = `- ${chapter.title} (${chapter.wordCount} words)`;
    const next = [...lines, line].join('\n');
    if (next.length > budget) break;
    lines.push(line);
  }
  return lines.join('\n');
}
