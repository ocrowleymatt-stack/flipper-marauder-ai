const MUSIC_VERB =
  /\b(compose|write|make|create|generate|draft|score|arrange)\b/i;
const MUSIC_NOUN =
  /\b(song|track|tune|beat|instrumental|midi|soundtrack|piano piece|music composition|composition)\b/i;

const OSINT_COLLISION =
  /\b(osint|digital footprint|username scan|who\(\)|enumerate (usernames?|accounts?))\b/i;
const WRITING_SCENE =
  /\bwrite a (musical )?scene\b|\b(draft chapter|manuscript|story bible|caspa gold)\b/i;
const WEBSITE_COLLISION =
  /\b(web\s*)?site|webpage|landing\s*page|homepage|microsite\b/i;
const RESEARCH_COLLISION =
  /\busing multiple independent\b|^research(ing)?\b|\bresearch (the )?(history|sources|web)\b/i;
const MEMORY_QUESTION = /\bwhat did i say\b|\bdog['’]?s name\b/i;

export function looksLikeMusicRequest(text: string): boolean {
  const t = text.trim();
  if (t.length < 10) return false;
  if (MEMORY_QUESTION.test(t) || OSINT_COLLISION.test(t)) return false;
  if (RESEARCH_COLLISION.test(t)) return false;
  if (WRITING_SCENE.test(t)) return false;
  if (WEBSITE_COLLISION.test(t) && !MUSIC_NOUN.test(t)) return false;
  if (/\b(build|create|generate|design)\b.{0,40}\b((web\s*)?site|webpage|landing\s*page)\b/i.test(t)) return false;
  if (/\bwrite a (scene|chapter|story|manuscript|poem|essay|novel)\b/i.test(t)) return false;
  if (MUSIC_VERB.test(t) && MUSIC_NOUN.test(t)) return true;
  if (/\b(song|track|tune)\s+about\b/i.test(t)) return true;
  if (/\bcompose (a |an |me )?(piece|song|track|piano)\b/i.test(t)) return true;
  if (/\bpiano piece\b/i.test(t) && MUSIC_VERB.test(t)) return true;
  return false;
}

export function looksLikeMusicFollowup(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  if (looksLikeMusicRequest(t)) return false;
  if (MEMORY_QUESTION.test(t) || OSINT_COLLISION.test(t) || RESEARCH_COLLISION.test(t)) return false;
  if (/\bwrite a (scene|chapter|story|manuscript)\b/i.test(t)) return false;
  if (WEBSITE_COLLISION.test(t) && /\b(build|create|preview|publish)\b/i.test(t)) return false;
  return (
    /\bmake (it|this|that|the (song|track|piece|tempo|beat))? ?slower\b/i.test(t) ||
    /\bmake (it|this|that) faster\b/i.test(t) ||
    /\bchange (it|this|that|the tempo) to\s+\d+\s*bpm\b/i.test(t) ||
    /\b\d+\s*bpm\b/i.test(t) ||
    /\badd (the |some |a )?(strings|violins?|orchestra|brass|drums|bass)\b/i.test(t) ||
    /\bremove (the )?(vocals?|voice|singing|choir)\b/i.test(t) ||
    /\bmake (the |this )?(chorus|hook) bigger\b/i.test(t) ||
    /\b(regenerate|try again|rebuild)\b.{0,20}\b(it|this|version|song|track|piece|composition)?\b/i.test(t) ||
    /\b(open|play|show)\b.{0,16}\b(it|the )?(song|track|piece|composition|wav|midi)\b/i.test(t)
  );
}

export function isMusicRevisionFollowup(text: string): boolean {
  const t = text.trim();
  if (!looksLikeMusicFollowup(t)) return false;
  if (/\b(open|play|show)\b.{0,16}\b(it|the )?(song|track|piece|composition|wav|midi)\b/i.test(t)) return false;
  return true;
}

export function isMusicRegenerateFollowup(text: string): boolean {
  return /\b(regenerate|try again|rebuild)\b/i.test(text.trim());
}

export function titleFromBrief(brief: string): string {
  const cleaned = brief.replace(/\s+/g, ' ').trim();
  const about = cleaned.match(/(?:song|track|tune|piece|composition)\s+(?:about|in|called)\s+(.+)$/i);
  const raw = (about?.[1] ?? cleaned)
    .replace(/^(please\s+)?(compose|write|make|create|generate|draft)\s+(me\s+)?(a |an )?/i, '')
    .replace(/\b(30-second|thirty second|\d+\s*-?\s*second)\b/gi, '')
    .replace(/\b\d+\s*BPM\b/gi, '')
    .replace(/\b(song|track|tune|beat|instrumental|midi|soundtrack|piano piece|music composition|composition|piece)\b/gi, '')
    .replace(/[?.!]+$/g, '')
    .trim();
  if (!raw) return 'Composition';
  const titled = raw.charAt(0).toUpperCase() + raw.slice(1);
  return titled.slice(0, 72);
}

export function libraryPathsForComposition(compositionId: string) {
  return {
    score: `compositions/${compositionId}/score.json`,
    midi: `compositions/${compositionId}/composition.mid`,
    wav: `compositions/${compositionId}/audition.wav`,
  };
}

export function compositionIdFromLibraryPath(path: string): string | null {
  const match = path.match(/^compositions\/(cmp_[^/]+)\//);
  return match?.[1] ?? null;
}
