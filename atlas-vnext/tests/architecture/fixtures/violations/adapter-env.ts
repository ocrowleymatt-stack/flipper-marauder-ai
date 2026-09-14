/**
 * Negative fixture: adapters must not read process.env.
 */
export function leak(): string | undefined {
  return process.env.OPENAI_API_KEY;
}
