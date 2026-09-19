import type { Message } from '@atlas-vnext/contracts';
import type { ConversationHistoryTurn } from '@atlas-vnext/contracts';

export const HISTORY_MESSAGE_LIMIT = 24;
export const HISTORY_CHAR_BUDGET = 24_000;

export function compileConversationHistory(
  messages: Message[],
  options: { excludeMessageId?: string | null; limit?: number; charBudget?: number } = {},
): ConversationHistoryTurn[] {
  const limit = options.limit ?? HISTORY_MESSAGE_LIMIT;
  const budget = options.charBudget ?? HISTORY_CHAR_BUDGET;
  const eligible = messages.filter((row) => {
    if (options.excludeMessageId && row.id === options.excludeMessageId) return false;
    if (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'system') return false;
    return row.content.trim().length > 0;
  });
  const selected: Message[] = [];
  let chars = 0;
  for (let i = eligible.length - 1; i >= 0; i -= 1) {
    const row = eligible[i]!;
    const size = row.content.length;
    if (selected.length >= limit) break;
    if (chars + size > budget) {
      const remaining = budget - chars;
      if (selected.length === 0 && remaining > 0) {
        selected.push({ ...row, content: row.content.slice(0, remaining) });
      }
      break;
    }
    selected.push(row);
    chars += size;
  }
  selected.reverse();
  return selected.map((row) => ({
    role: row.role === 'system' ? 'system' : row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
  }));
}
