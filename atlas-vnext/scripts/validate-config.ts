#!/usr/bin/env tsx
import {
  PRODUCTION_CONFIG_CATALOGUE,
  ProductionConfigError,
  publicConfigView,
  readProductionHostConfig,
} from '../apps/host/src/production-config.ts';

const production = process.argv.includes('--production');
if (production) {
  // `--production` is authoritative: validate the production contract even when
  // NODE_ENV / ATLAS_ENV were not independently set to production.
  const config = readProductionHostConfig(process.env, { forceProduction: true });
  if (!config.production) {
    throw new ProductionConfigError('--production did not evaluate a production configuration.');
  }
  if (config.topology.ha !== false || config.topology.topology !== 'single-instance') {
    throw new Error('Production config refused to claim an unsupported HA topology.');
  }
  console.log(JSON.stringify({ ok: true, config: publicConfigView(config) }, null, 2));
} else {
  console.log(
    JSON.stringify(
      {
        ok: true,
        catalogue: PRODUCTION_CONFIG_CATALOGUE.map((item) => ({
          name: item.name,
          classification: item.classification,
          production: item.production,
        })),
      },
      null,
      2,
    ),
  );
}
