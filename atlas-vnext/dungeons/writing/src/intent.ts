import type { WritingOperation } from '@atlas-vnext/contracts';

const INTERNAL_PROMPT = /Capability policy:|Caspa writing behaviour:|Current document:/i;

const OSINT_COLLISION =
  /\b(osint|digital footprint|username scan|who\(\)|enumerate (usernames?|accounts?))\b/i;
const OSINT_FOLLOWUP =
  /\b(strongest (finding|evidence|observation)|which of those findings|which sources|those findings)\b/i;
const RESEARCH_COLLISION =
  /\busing multiple independent\b|^research(ing)?\b|\bresearch (the )?(history|sources|web)\b/i;
const WEBSITE_COLLISION =
  /\bwrite a (web\s*)?site\b|\bwrite a landing page\b|\b(build|make|create|generate|design)\b.{0,40}\b((web\s*)?site|webpage|landing\s*page|homepage|microsite)\b|\b(website|web site|landing page)\s+(about|for|on)\b/i;
const ARTIFACT_OPEN =
  /\bopen (the |that )?(manuscript|document|file|second|first|third|last|finding|source)/i;
const MEMORY_QUESTION = /\bwhat did i say\b|\bdog['’]?s name\b/i;

export function looksLikeWritingRequest(text: string): boolean {
  const q = text.trim();
  if (!q || q.length > 4000) return false;
  if (INTERNAL_PROMPT.test(q)) return false;
  if (OSINT_COLLISION.test(q) || OSINT_FOLLOWUP.test(q)) return false;
  if (RESEARCH_COLLISION.test(q)) return false;
  if (WEBSITE_COLLISION.test(q)) return false;
  if (ARTIFACT_OPEN.test(q)) return false;
  if (MEMORY_QUESTION.test(q)) return false;

  if (looksLikeGoldRequest(q) || looksLikeStoryBibleUpdate(q)) return true;
  if (/\bwrite a\b/i.test(q)) return true;
  if (/\bdraft chapter\b/i.test(q)) return true;
  if (
    /\b(write|draft|compose|rewrite|revise|shorten|expand|outline)\b/i.test(q) &&
    /\b(scene|chapter|story|manuscript|dialogue|paragraph|section|prose|novel|poem|essay|book)\b/i.test(q)
  ) {
    return true;
  }
  return false;
}

export function looksLikeWritingFollowup(text: string): boolean {
  const q = text.trim();
  if (!q || q.length > 2000) return false;
  if (INTERNAL_PROMPT.test(q)) return false;
  if (OSINT_COLLISION.test(q) || OSINT_FOLLOWUP.test(q)) return false;
  if (RESEARCH_COLLISION.test(q)) return false;
  if (WEBSITE_COLLISION.test(q)) return false;
  if (ARTIFACT_OPEN.test(q)) return false;
  if (MEMORY_QUESTION.test(q)) return false;
  if (looksLikeWritingRequest(q)) return false;
  const lower = q.toLowerCase();
  if (/\bmake (the |that )?(final |last )?(paragraph|section|dialogue|scene|prose|tone)\b/.test(lower)) return true;
  if (/\b(less formal|more restrained|tighten that|rewrite that|edit that|revise that)\b/.test(lower)) return true;
  if (/\bmake that dialogue\b/.test(lower)) return true;
  if (/\b(next chapter|chapter two|chapter 2)\b/.test(lower) && /\b(write|draft|generate|continue)\b/.test(lower)) {
    return true;
  }
  return false;
}

export function looksLikeGoldRequest(text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return false;
  if (/\bcaspa gold\b/.test(q)) return true;
  if (/\bgold refin/.test(q)) return true;
  if (/\bfull editorial pass\b/.test(q)) return true;
  if (/\brefine this\b/.test(q)) return true;
  return false;
}

export function looksLikeStoryBibleUpdate(text: string): boolean {
  const q = text.trim();
  if (!q) return false;
  if (/\bstory bible\b/i.test(q) && /\b(add|set|update|remember|establish|save)\b/i.test(q)) return true;
  if (/\bestablish (in )?(the )?(project|story|canon|bible)\b/i.test(q)) return true;
  if (/\bremember for this (story|project|book)\b/i.test(q)) return true;
  if (/\badd to (the )?(story )?bible\b/i.test(q)) return true;
  return false;
}

export function inferWritingOperation(text: string, hasDocument: boolean): WritingOperation {
  const q = text.trim().toLowerCase();
  if (looksLikeGoldRequest(text)) return 'refine';
  if (/\boutline\b/.test(q)) return 'outline';
  if (/\bshorten\b|\bcut (this|that|the)\b/.test(q)) return 'shorten';
  if (/\bexpand\b/.test(q)) return 'expand';
  if (/\b(less formal|more restrained|tone|dialogue)\b/.test(q)) return 'tone';
  if (/\brewrite\b/.test(q)) return 'rewrite';
  if (/\bcorrect\b/.test(q)) return 'correct';
  if (/\b(continue|next chapter|chapter two|chapter 2)\b/.test(q) && hasDocument) return 'continue';
  if (hasDocument && looksLikeWritingFollowup(text)) return 'tone';
  return hasDocument ? 'rewrite' : 'create';
}

export function extractStoryBibleFact(text: string): string {
  const stripped = text
    .trim()
    .replace(/^(please\s+)?(remember for this (story|project|book)|establish (in )?(the )?(project|story|canon|bible)|add to (the )?(story )?bible)\s*(that\s*)?/i, '')
    .replace(/^that\s+/i, '')
    .trim();
  return stripped || text.trim();
}

export function titleFromWritingAsk(instruction: string): string {
  const text = instruction.trim().replace(/\s+/g, ' ');
  const about = text.match(/\b(?:scene|chapter|story|manuscript|piece) about (.+)$/i);
  if (about?.[1]) return capTitle(about[1]);
  const draft = text.match(/\bdraft (?:chapter\s+)?(.+)$/i);
  if (draft?.[1]) return capTitle(draft[1]);
  return capTitle(text);
}

function capTitle(value: string): string {
  const cleaned = value.replace(/[.?!]+$/g, '').trim();
  if (!cleaned) return 'Untitled document';
  return cleaned.slice(0, 72);
}
