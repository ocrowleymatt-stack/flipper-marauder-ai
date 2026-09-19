/**
 * Curated high-value public username presence catalog.
 * Behaviour recovered from commons DEFAULT_USERNAME_PLATFORMS + TBB Sherlock-style
 * error classification. Not a vendor of the 473-site suite (later tranche).
 */
export interface UsernameSite {
  id: string;
  site: string;
  urlTemplate: string;
  category: string;
  /** Substrings that mean the profile does not exist even on HTTP 200. */
  soft404?: string[];
}

export const USERNAME_SITES: UsernameSite[] = [
  { id: 'github', site: 'GitHub', urlTemplate: 'https://github.com/{username}', category: 'dev', soft404: ['not found'] },
  { id: 'gitlab', site: 'GitLab', urlTemplate: 'https://gitlab.com/{username}', category: 'dev' },
  { id: 'reddit', site: 'Reddit', urlTemplate: 'https://www.reddit.com/user/{username}', category: 'social', soft404: ['page not found', "sorry, nobody on reddit goes by that name"] },
  { id: 'hackernews', site: 'Hacker News', urlTemplate: 'https://news.ycombinator.com/user?id={username}', category: 'community', soft404: ['no such user'] },
  { id: 'bitbucket', site: 'Bitbucket', urlTemplate: 'https://bitbucket.org/{username}', category: 'dev' },
  { id: 'keybase', site: 'Keybase', urlTemplate: 'https://keybase.io/{username}', category: 'identity' },
  { id: 'wikipedia', site: 'Wikipedia', urlTemplate: 'https://en.wikipedia.org/wiki/User:{username}', category: 'community', soft404: ['wikipedia does not have a user page'] },
  { id: 'npm', site: 'npm', urlTemplate: 'https://www.npmjs.com/~{username}', category: 'dev' },
];

export const OSINT_BOUNDS = {
  maxSites: 8,
  maxVariants: 4,
  parallelism: 4,
  probeTimeoutMs: 8_000,
  overallTimeoutMs: 40_000,
  maxSearchHits: 4,
};

export function resolveSiteUrl(site: UsernameSite, username: string): string {
  const handle = encodeURIComponent(username.replace(/^@/, '').trim());
  return site.urlTemplate.replaceAll('{username}', handle);
}
