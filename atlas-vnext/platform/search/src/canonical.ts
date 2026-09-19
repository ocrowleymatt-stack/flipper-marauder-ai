const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'msclkid',
  'mc_eid',
  'mc_cid',
  'igshid',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_reader',
  'utm_name',
  'ref',
  'ref_src',
  'ref_url',
  'source',
  'yclid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
]);

export function canonicalUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return trimmed;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }
    const kept = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()));
    kept.sort(([a], [b]) => a.localeCompare(b));
    url.search = '';
    for (const [key, value] of kept) url.searchParams.append(key, value);
    let path = url.pathname.replace(/\/{2,}/g, '/');
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    url.pathname = path;
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function hostnameOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function classifySourceType(url: string): 'official' | 'academic' | 'code' | 'discussion' | 'encyclopedia' | 'general' {
  const host = hostnameOf(url);
  if (
    host.endsWith('.gov') ||
    host.endsWith('.gov.uk') ||
    host.endsWith('.ac.uk') ||
    host.includes('who.int') ||
    host.includes('europa.eu')
  ) {
    return 'official';
  }
  if (
    host.includes('wikipedia.org') ||
    host.includes('britannica.com') ||
    host.includes('wikidata.org')
  ) {
    return 'encyclopedia';
  }
  if (
    host.includes('arxiv.org') ||
    host.includes('doi.org') ||
    host.includes('nih.gov') ||
    host.includes('pubmed') ||
    host.includes('jstor.org') ||
    host.includes('crossref.org') ||
    host.includes('semanticscholar.org')
  ) {
    return 'academic';
  }
  if (
    host.includes('github.com') ||
    host.includes('gitlab.com') ||
    host.includes('bitbucket.org') ||
    host.includes('stackoverflow.com')
  ) {
    return 'code';
  }
  if (
    host.includes('reddit.com') ||
    host.includes('news.ycombinator') ||
    host.includes('twitter.com') ||
    host.includes('x.com') ||
    host.includes('medium.com')
  ) {
    return 'discussion';
  }
  return 'general';
}
