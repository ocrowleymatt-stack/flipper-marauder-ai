import { createHash } from "node:crypto";
import {
  assertContentAddress,
  type ContentAddress,
  type Provenance,
} from "@atlas-vnext/contracts";

export interface ContentStore {
  put(bytes: Uint8Array, provenance: Provenance, mediaType: string): Promise<ContentAddress>;
  get(address: ContentAddress): Promise<Uint8Array>;
}

/** In-memory CAS stub. Not for production. Path locators are not accepted. */
export class MemoryContentStore implements ContentStore {
  readonly #blobs = new Map<ContentAddress, Uint8Array>();

  async put(bytes: Uint8Array, provenance: Provenance, _mediaType: string): Promise<ContentAddress> {
    if (!provenance.source) throw new Error("provenance required");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const address = assertContentAddress(`cas:sha256:${digest}`);
    this.#blobs.set(address, bytes);
    return address;
  }

  async get(address: ContentAddress): Promise<Uint8Array> {
    const canonical = assertContentAddress(address);
    const bytes = this.#blobs.get(canonical);
    if (!bytes) throw new Error(`missing blob ${canonical}`);
    return bytes;
  }
}
