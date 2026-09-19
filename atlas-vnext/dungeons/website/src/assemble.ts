import { titleFromBrief } from './intent.ts';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function assembleSiteHtml(brief: string): string {
  const title = titleFromBrief(brief);
  const palette = paletteFor(brief);
  const summary = escapeHtml(brief.replace(/\s+/g, ' ').trim().slice(0, 280));
  const safeTitle = escapeHtml(title);
  const sections = sectionCopy(title, brief);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    :root { --ink:#${palette.ink}; --paper:#${palette.paper}; --accent:#${palette.accent}; --muted:#${palette.muted}; }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: var(--paper); color: var(--ink); font: 18px/1.55 Georgia, "Times New Roman", serif; }
    a { color: var(--accent); }
    .wrap { max-width: 880px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
    header { border-bottom: 2px solid var(--accent); padding-bottom: 1.25rem; margin-bottom: 2rem; }
    .kicker { letter-spacing: .16em; text-transform: uppercase; font-size: .72rem; color: var(--muted); }
    h1 { font-size: clamp(2rem, 5vw, 3.4rem); line-height: 1.1; margin: .35rem 0 1rem; }
    h2 { font-size: 1.35rem; margin: 2rem 0 .6rem; }
    .hero { background: var(--ink); color: var(--paper); padding: 1.5rem; border-radius: 18px; }
    .hero p { margin: 0; font-size: 1.05rem; }
    footer { margin-top: 3rem; font-size: .85rem; color: var(--muted); }
    .skip { position: absolute; left: -999px; }
    .skip:focus { left: 1rem; top: 1rem; background: var(--paper); padding: .4rem .7rem; }
  </style>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <div class="wrap">
    <header>
      <p class="kicker">Atlas Website Studio</p>
      <h1>${safeTitle}</h1>
    </header>
    <main id="main">
      <section class="hero" aria-label="Introduction">
        <p>${summary}</p>
      </section>
      ${sections}
    </main>
    <footer>
      <p>Preview revision. Not production. Atlas assembled this page from the brief.</p>
    </footer>
  </div>
</body>
</html>
`;
}

function sectionCopy(title: string, brief: string): string {
  const safeTitle = escapeHtml(title);
  const beats = splitBeats(brief);
  const items = beats
    .map((beat) => `<li>${escapeHtml(beat)}</li>`)
    .join('');
  return `<section>
  <h2>Visit</h2>
  <p>${safeTitle} is a public page Atlas can preview, audit, and later publish when an owner allows it.</p>
</section>
<section>
  <h2>From the brief</h2>
  <ul>${items}</ul>
</section>`;
}

function splitBeats(brief: string): string[] {
  const parts = brief
    .split(/[.;\n]+/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 8)
    .slice(0, 4);
  return parts.length ? parts : [brief.replace(/\s+/g, ' ').trim().slice(0, 160)];
}

function paletteFor(brief: string): { ink: string; paper: string; accent: string; muted: string } {
  let hash = 2166136261;
  for (let i = 0; i < brief.length; i += 1) {
    hash ^= brief.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hue = Math.abs(hash) % 360;
  return {
    ink: hslToHex(hue, 32, 14),
    paper: hslToHex((hue + 18) % 360, 28, 95),
    accent: hslToHex((hue + 40) % 360, 55, 38),
    muted: hslToHex(hue, 12, 38),
  };
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) =>
    Math.round(255 * x)
      .toString(16)
      .padStart(2, '0');
  return `${to(f(0))}${to(f(8))}${to(f(4))}`;
}
