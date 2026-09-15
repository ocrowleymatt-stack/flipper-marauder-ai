#!/usr/bin/env tsx
import { PRODUCTION_CONFIG_CATALOGUE, publicConfigView, readProductionHostConfig } from '../apps/host/src/production-config.ts';

const production = process.argv.includes('--production');
if (production) {
  const config = readProductionHostConfig(process.env);
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
