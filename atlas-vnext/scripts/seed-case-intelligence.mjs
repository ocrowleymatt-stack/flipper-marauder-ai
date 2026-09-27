#!/usr/bin/env node
/**
 * Seed Atlas Case Intelligence from the lossless contact-intelligence JSONL export.
 * Production target is PostgreSQL via DATABASE_URL. The original SQLite file is never
 * treated as Atlas's product database.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const input = process.argv[2] || process.env.ATLAS_INTELLIGENCE_JSONL;
const tenantId = process.env.ATLAS_TENANT_ID;
const workspaceId = process.env.ATLAS_WORKSPACE_ID;
const caseId = process.env.ATLAS_CASE_ID || crypto.randomUUID();
const caseTitle = process.env.ATLAS_CASE_TITLE || 'Contact and Case Intelligence';
if (!input || !tenantId || !workspaceId || !process.env.DATABASE_URL) {
  console.error('Usage: DATABASE_URL=... ATLAS_TENANT_ID=... ATLAS_WORKSPACE_ID=... node scripts/seed-case-intelligence.mjs occurrences.jsonl');
  process.exit(2);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query('BEGIN');
try {
  await client.query(`INSERT INTO intelligence_cases(id,tenant_id,workspace_id,title)
    VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`, [caseId,tenantId,workspaceId,caseTitle]);

  const sourceIds = new Map();
  const entityIds = new Map();
  let rows=0, observations=0;
  const rl=readline.createInterface({input:fs.createReadStream(input,{encoding:'utf8'}),crlfDelay:Infinity});
  for await (const line of rl) {
    if (!line.trim()) continue;
    const x=JSON.parse(line); rows++;
    let sid=sourceIds.get(x.source);
    if (!sid) {
      sid=crypto.randomUUID(); sourceIds.set(x.source,sid);
      await client.query(`INSERT INTO intelligence_sources(id,tenant_id,workspace_id,case_id,source_type,title,metadata)
        VALUES($1,$2,$3,$4,'import',$5,$6::jsonb) ON CONFLICT(id) DO NOTHING`,
        [sid,tenantId,workspaceId,caseId,x.source,JSON.stringify({import:'contact-intelligence'})]);
    }
    const key=`${x.kind}:${x.normalised}`;
    let eid=entityIds.get(key);
    if (!eid) {
      const existing=await client.query(`SELECT id FROM intelligence_entities WHERE tenant_id=$1 AND workspace_id=$2 AND entity_type=$3 AND canonical_value=$4 LIMIT 1`,
        [tenantId,workspaceId,x.kind,x.normalised]);
      eid=existing.rows[0]?.id || crypto.randomUUID(); entityIds.set(key,eid);
      if (!existing.rows[0]) await client.query(`INSERT INTO intelligence_entities(id,tenant_id,workspace_id,case_id,entity_type,canonical_label,canonical_value)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[eid,tenantId,workspaceId,caseId,x.kind,x.observed||x.normalised,x.normalised]);
    }
    await client.query(`INSERT INTO intelligence_observations(id,tenant_id,workspace_id,case_id,source_id,entity_id,observation_type,observed_value,source_locator,confidence,raw_context,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'source_fact',$10,$11::jsonb)`,[
        crypto.randomUUID(),tenantId,workspaceId,caseId,sid,eid,x.kind,x.observed||x.normalised,
        JSON.stringify({sheet:x.sheet,row:x.row,cell:x.cell}),x.context||null,JSON.stringify({normalised:x.normalised})]);
    observations++;
    if (rows % 1000 === 0) console.log(`seeded ${rows} rows`);
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({caseId,rows,observations,sources:sourceIds.size,entities:entityIds.size}));
} catch (e) {
  await client.query('ROLLBACK'); throw e;
} finally { await client.end(); }
