/** Content-addressed locator. Paths are illegal. */
export type ContentAddress = `cas:sha256:${string}`;

export const CONTENT_ADDRESS_RE = /^cas:sha256:[0-9a-f]{64}$/;

export function isContentAddress(value: string): value is ContentAddress {
  return CONTENT_ADDRESS_RE.test(value);
}

export function assertContentAddress(value: string): ContentAddress {
  if (!isContentAddress(value)) {
    throw new Error(`Not a content address: ${value}`);
  }
  return value;
}
