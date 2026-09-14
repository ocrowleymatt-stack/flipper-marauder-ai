import { PersistenceConfigError } from './errors.ts';
import type { PersistenceConfig } from './config.ts';
import type { PlatformPersistence } from './kernel.ts';
import { openMemoryPersistence } from './memory/kernel.ts';
import { openPostgresPersistence } from './postgres/kernel.ts';

/**
 * Open the production-capable persistence kernel.
 * `file` mode is the local JSON document (`openDurableStore`) and is not a
 * second architecture here — requesting it on this factory fails closed.
 */
export async function openPlatformPersistence(config: PersistenceConfig): Promise<PlatformPersistence> {
  if (config.mode === 'postgres') {
    return openPostgresPersistence(config);
  }
  if (config.mode === 'memory') {
    if (config.production) {
      throw new PersistenceConfigError('Production persistence cannot use the in-memory adapter.');
    }
    return openMemoryPersistence();
  }
  if (config.production) {
    throw new PersistenceConfigError(
      'Production persistence requires PostgreSQL. File/JSON mode is local-dev only.',
    );
  }
  throw new PersistenceConfigError(
    'File persistence is opened via openDurableStore(); openPlatformPersistence serves memory/postgres kernels.',
  );
}
