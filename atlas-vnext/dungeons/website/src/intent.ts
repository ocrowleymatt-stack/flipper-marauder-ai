const WEBSITE_VERB =
  /\b(build|make|create|generate|design|draft|compose|spin\s*up|put\s+together)\b/i;
const WEBSITE_NOUN =
  /\b((web\s*)?site|webpage|web\s*page|landing\s*page|home\s*page|homepage|microsite)\b/i;

export function looksLikeWebsiteRequest(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  if (/\b(what did i say|dog'?s name|those findings|run osint)\b/i.test(t)) return false;
  if (/\bresearch\b/i.test(t) && !WEBSITE_NOUN.test(t)) return false;
  if (WEBSITE_VERB.test(t) && WEBSITE_NOUN.test(t)) return true;
  if (/\b(website|web site|landing page)\s+(about|for|on)\b/i.test(t)) return true;
  return false;
}

export function looksLikeWebsiteFollowup(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  if (looksLikeWebsiteRequest(t)) return false;
  return (
    /\b(open|show|see)\b.{0,24}\b(preview|site|page)\b/i.test(t) ||
    /\b(publish|promote)\b.{0,16}\b(it|site|preview)?\b/i.test(t) ||
    /\b(what files|which files|the html|the preview)\b/i.test(t) ||
    /\b(regenerate|try again|rebuild)\b.{0,20}\b(site|page|it)?\b/i.test(t)
  );
}

export function titleFromBrief(brief: string): string {
  const cleaned = brief.replace(/\s+/g, ' ').trim();
  const about = cleaned.match(
    /(?:website|web site|site|page|landing page)\s+(?:about|for|on)\s+(.+)$/i,
  );
  const raw = (about?.[1] ?? cleaned)
    .replace(/^(please\s+)?(build|make|create|generate|design)\s+(me\s+)?(a\s+)?/i, '')
    .replace(/\b(website|web site|site|webpage|landing page)\b/gi, '')
    .replace(/[?.!]+$/g, '')
    .trim();
  if (!raw) return 'Site';
  const titled = raw.charAt(0).toUpperCase() + raw.slice(1);
  return titled.slice(0, 72);
}
