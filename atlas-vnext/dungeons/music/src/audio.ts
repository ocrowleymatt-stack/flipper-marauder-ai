import type { AudioRenderRequest, AudioRenderResult } from '@atlas-vnext/contracts';

export interface AudioRenderPort {
  render(input: AudioRenderRequest, signal?: AbortSignal): Promise<AudioRenderResult>;
}
