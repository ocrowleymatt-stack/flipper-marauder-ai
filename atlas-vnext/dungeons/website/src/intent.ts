const WEBSITE_VERB =
  /\b(build|make|create|generate|design|draft|compose|spin\s*up|put\s+together)\b/i;
const WEBSITE_NOUN =
  /\b((web\s*)?site|webpage|web\s*page|landing\s*page|home\s*page|homepage|microsite)\b/i;

const OSINT_COLLISION =
  /\b(osint|digital footprint|username scan|who\(\)|enumerate (usernames?|accounts?))\b/i;
const WRITING_COLLISION =
  /\b(write a\b|draft chapter|manuscript|story bible|caspa gold)\b/i;
const RESEARCH_COLLISION =
  /\busing multiple independent\b|^research(ing)?\b|\bresearch (the )?(history|sources|web)\b/i;
const MEMORY_QUESTION = /\bwhat did i say\b|\bdog['’]?s name\b/i;

export function looksLikeWebsiteRequest(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  if (MEMORY_QUESTION.test(t) || OSINT_COLLISION.test(t)) return false;
  if (RESEARCH_COLLISION.test(t) && !WEBSITE_VERB.test(t)) return false;
  if (WRITING_COLLISION.test(t) && !WEBSITE_NOUN.test(t)) return false;
  if (/\bwrite a (scene|chapter|story|manuscript|poem|essay|novel)\b/i.test(t)) return false;
  if (WEBSITE_VERB.test(t) && WEBSITE_NOUN.test(t)) return true;
  if (/\b(website|web site|landing page)\s+(about|for|on)\b/i.test(t)) return true;
  if (/\bwrite a (web\s*)?site\b/i.test(t) || /\bwrite a landing page\b/i.test(t)) return true;
  return false;
}

export function looksLikeWebsiteFollowup(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  if (looksLikeWebsiteRequest(t)) return false;
  if (MEMORY_QUESTION.test(t) || OSINT_COLLISION.test(t) || RESEARCH_COLLISION.test(t)) return false;
  if (/\bwrite a (scene|chapter|story|manuscript)\b/i.test(t)) return false;
  return (
    /\b(open|show|see)\b.{0,24}\b(preview|site|page)\b/i.test(t) ||
    /\b(publish|promote)\b.{0,16}\b(it|site|preview)?\b/i.test(t) ||
    /\b(what files|which files|the html|the preview)\b/i.test(t) ||
    /\b(regenerate|rebuild)\b.{0,20}\b(site|page|it|preview)?\b/i.test(t) ||
    /\btry again\b.{0,24}\b(site|page|preview)\b/i.test(t) ||
    /\bmake (the |this |that )?(hero|headline|header)\b.{0,24}\b(shorter|taller|smaller|larger|cleaner)?\b/i.test(t) ||
    /\badd (a |the )?(contact|hero|footer|about|pricing) (section|block|form)\b/i.test(t) ||
    /\bchange (the |this )?(copy|tone|text)\b/i.test(t) ||
    /\bmake (this |the )?(mobile )?layout\b/i.test(t) ||
    /\b(revise|update|edit|tweak)\b.{0,20}\b(site|page|preview|hero|layout)\b/i.test(t)
  );
}

export function isWebsiteRevisionFollowup(text: string): boolean {
  const t = text.trim();
  if (!looksLikeWebsiteFollowup(t)) return false;
  if (/\b(open|show|see)\b.{0,24}\b(preview|site|page)\b/i.test(t)) return false;
  if (/\b(publish|promote)\b/i.test(t)) return false;
  if (/\b(what files|which files|the html|the preview)\b/i.test(t) && !/\b(regenerate|rebuild|revise|update|edit)\b/i.test(t)) {
    return false;
  }
  return true;
}

export function isWebsiteRegenerateFollowup(text: string): boolean {
  return /\b(regenerate|try again|rebuild)\b/i.test(text.trim());
}

export function titleFromBrief(brief: string): string {
  const cleaned = brief.replace(/\s+/g, ' ').trim();
  const about = cleaned.match(
    /(?:website|web site|site|page|landing page)\s+(?:about|for|on)\s+(.+)$/i,
  );
  const raw = (about?.[1] ?? cleaned)
    .replace(/^(please\s+)?(build|make|create|generate|design|write)\s+(me\s+)?(a\s+)?/i, '')
    .replace(/\b(website|web site|site|webpage|landing page)\b/gi, '')
    .replace(/[?.!]+$/g, '')
    .trim();
  if (!raw) return 'Site';
  const titled = raw.charAt(0).toUpperCase() + raw.slice(1);
  return titled.slice(0, 72);
}

export function libraryPathForSite(siteId: string): string {
  return `sites/${siteId}/index.html`;
}

export function siteIdFromLibraryPath(path: string): string | null {
  const match = path.match(/^sites\/(site_[^/]+)\/index\.html$/);
  return match?.[1] ?? null;
}
