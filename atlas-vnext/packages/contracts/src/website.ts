/**
 * Host-injected HTML generation. Nexus still owns WHERE; Execution owns HOW.
 * Website Studio must not call ConversationRuntime.sendMessage or import Execution.
 */
export interface SiteGeneratePort {
  generateHtml(input: {
    brief: string;
    previousHtml?: string | null;
    signal?: AbortSignal;
    privacy?: 'any' | 'local_only';
  }): Promise<{ html: string }>;
}
