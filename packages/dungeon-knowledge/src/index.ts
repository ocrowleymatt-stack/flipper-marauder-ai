import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type {
  DungeonExecutionContext,
  DungeonManifest,
  IDungeonPlugin,
} from '@atlas/core-contracts';

export interface EncryptedTokenEnvelope {
  readonly version: 1;
  readonly algorithm: 'aes-256-gcm';
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export function encryptOAuthToken(token: string, secretKey: string): EncryptedTokenEnvelope {
  const key = createHash('sha256').update(secretKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([cipher.update(token, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

export function decryptOAuthToken(envelope: EncryptedTokenEnvelope, secretKey: string): string {
  const key = createHash('sha256').update(secretKey).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf-8');
}

export class DungeonKnowledge implements IDungeonPlugin {
  readonly manifest: DungeonManifest = {
    id: 'dungeon-knowledge',
    name: 'Knowledge Autopilot Dungeon',
    version: '0.1.0',
    description: 'Autonomous cloud corpus ingestion, ephemeral processing, and AES-256-GCM token storage',
    capabilitiesProvided: ['knowledge:sync', 'knowledge:parse_document'],
    requiredPermissions: ['permission:knowledge_ingest'],
  };

  async execute(
    taskType: string,
    payload: Readonly<Record<string, unknown>>,
    context: DungeonExecutionContext,
  ): Promise<Record<string, unknown>> {
    await context.reportProgress(10, 'Initializing knowledge autopilot pipeline');

    if (taskType === 'knowledge:parse_document') {
      const docName = String(payload.name || 'document.txt');
      const content = String(payload.content || '');

      await context.reportProgress(40, `Extracting and chunking text from ${docName}`);
      const chunks = content
        .split(/\n\s*\n/)
        .map((c) => c.trim())
        .filter(Boolean);

      await context.reportProgress(80, 'Saving knowledge chunks to CAS');
      const blob = await context.storage.put(JSON.stringify(chunks), 'application/json', {
        sourceName: docName,
        chunkCount: chunks.length,
      });

      await context.reportProgress(100, 'Document ingestion complete');
      return {
        docName,
        chunkCount: chunks.length,
        blobHash: blob.hash,
      };
    }

    throw new Error(`Unsupported knowledge task: ${taskType}`);
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: 'Knowledge Autopilot Dungeon ready' };
  }
}
