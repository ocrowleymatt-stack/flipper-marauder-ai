import { z } from 'zod';

export const audioRenderStatusSchema = z.enum(['rendered', 'unavailable', 'failed']);
export type AudioRenderStatus = z.infer<typeof audioRenderStatusSchema>;

export const audioRenderRequestSchema = z.object({
  title: z.string().min(1),
  brief: z.string().min(1),
  compositionText: z.string().default(''),
  instruction: z.string().optional(),
  parentHash: z.string().length(64).optional(),
});
export type AudioRenderRequest = z.infer<typeof audioRenderRequestSchema>;

export interface AudioRenderResult {
  status: AudioRenderStatus;
  bytes: Uint8Array | null;
  mimeType: string | null;
  renderer: string;
  durationMs: number | null;
  detail: string;
}
