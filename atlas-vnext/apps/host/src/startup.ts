import { composeSpine, type ComposeOptions, type Spine } from './compose.ts';
import { readiness } from './ops.ts';
import { isProductionEnv, readTimeoutContract } from './production-config.ts';
import {
  StartupTimeoutError,
  raceStartup,
  throwIfStartupAborted,
  withStartupDeadline,
} from './startup-deadline.ts';

export { StartupTimeoutError, raceStartup, throwIfStartupAborted, withStartupDeadline } from './startup-deadline.ts';

export async function bootSpine(
  options: ComposeOptions & {
    production?: boolean;
    compose?: (input: ComposeOptions) => Promise<Spine>;
    ready?: typeof readiness;
  },
): Promise<Spine> {
  const env = options.env ?? process.env;
  const timeouts = readTimeoutContract(env);
  const production = options.production === true || isProductionEnv(env);
  const compose = options.compose ?? composeSpine;
  const ready = options.ready ?? readiness;
  return withStartupDeadline(timeouts.startupMs, async (signal) => {
    const spine = await compose({ ...options, signal });
    try {
      if (production) {
        throwIfStartupAborted(signal, timeouts.startupMs);
        const probed = await raceStartup(signal, ready(spine.healthProbe, true), timeouts.startupMs);
        if (!probed.ready) {
          throw new Error(`Host refused to listen: dependencies not ready (${JSON.stringify(probed.dependencies)}).`);
        }
      }
      return spine;
    } catch (err) {
      await spine.close().catch(() => undefined);
      throw err;
    }
  });
}
