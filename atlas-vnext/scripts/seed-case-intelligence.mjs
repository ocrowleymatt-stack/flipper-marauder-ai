#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const input = process.argv[2] || process.env.ATLAS_INTELLIGENCE_JSONL;
const tenantId = process.env.ATLAS_TENANT_ID;
const workspaceId = process.env.ATLAS_WORKSPACE_ID;
const caseTitle = process.env.ATLAS_CASE_TITLE || 'Contact and Case Intelligence';
const caseId = process.env.ATLAS_CASE_ID || stableId('case', tenantId, workspaceId, caseTitle);
if (!input || !tenantId || !workspaceId || !process.env.DATABASE_URL) {
  console.error('Usage: DATABASE_URL=... ATLAS_TENANT_ID=... ATLAS_WORKSPACE_ID=... node scripts/seed-case-intelligence.mjs occurrences.jsonl');
  process.exit(2);
}

function stableId(kind, ...parts) {
  return `${kind}_${crypto.createHash('sha256').update(parts.map(v => String(v ?? '')).join('\u001f')).digest('hex').slice(0, 32)}`;
}
function locator(x) { return { sheet:x.sheet ?? null, row:x.row ?? null, cell:x.cell ?? null }; }

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query('BEGIN');
try {
  const scope = await client.query(`SELECT w.id FROM workspaces w WHERE w.id=$1 AND w.tenant_id=$2 LIMIT 1`, [workspaceId, tenantId]);
  if (!scope.rowCount) throw new Error('Authority scope rejected: workspace does not belong to tenant');

  await client.query(`INSERT INTO intelligence_cases(id,tenant_id,workspace_id,title)
    VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title, updated_at=now()`, [caseId,tenantId,workspaceId,caseTitle]);

  const sourceIds = new Map();
  const entityIds = new Map();
  let rows=0, insertedObservations=0;
  const rl=readline.createInterface({input:fs.createReadStream(input,{encoding:'utf8'}),crlfDelay:Infinity});
  for await (const line of rl) {
    if (!line.trim()) continue;
    const x=JSON.parse(line); rows++;
    const sourceKey=String(x.source ?? 'unknown');
    let sid=sourceIds.get(sourceKey);
    if (!sid) {
      sid=stableId('src',tenantId,workspaceId,caseId,sourceKey); sourceIds.set(sourceKey,sid);
      await client.query(`INSERT INTO intelligence_sources(id,tenant_id,workspace_id,case_id,source_type,title,external_ref,metadata)
        VALUES($1,$2,$3,$4,'import',$5,$6,$7::jsonb) ON CONFLICT(id) DO NOTHING`,
        [sid,tenantId,workspaceId,caseId,sourceKey,sourceKey,JSON.stringify({import:'contact-intelligence'})]);
    }

    const normalised=String(x.normalised ?? x.observed ?? '').trim();
    if (!normalised) continue;
    const entityKey=`${x.kind}:${normalised}`;
    let eid=entityIds.get(entityKey);
    if (!eid) {
      eid=stableId('ent',tenantId,workspaceId,x.kind,normalised); entityIds.set(entityKey,eid);
      await client.query(`INSERT INTO intelligence_entities(id,tenant_id,workspace_id,entity_type,canonical_label,canonical_value)
        VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(id) DO UPDATE SET canonical_label=EXCLUDED.canonical_label, updated_at=now()`,
        [eid,tenantId,workspaceId,x.kind,x.observed||normalised,normalised]);
    }

    const observed=String(x.observed ?? normalised);
    const loc=locator(x);
    const oid=stableId('obs',tenantId,workspaceId,caseId,sid,eid,x.kind,observed,JSON.stringify(loc));
    const result=await client.query(`INSERT INTO intelligence_observations(
        id,tenant_id,workspace_id,case_id,source_id,entity_id,observation_type,observed_value,source_locator,epistemic_class,raw_context,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'source_fact',$10,$11::jsonb)
      ON CONFLICT(id) DO NOTHING RETURNING id`,[
        oid,tenantId,workspaceId,caseId,sid,eid,x.kind,observed,JSON.stringify(loc),x.context||null,JSON.stringify({normalised})]);
    insertedObservations += result.rowCount;
    if (rows % 1000 === 0) console.log(`processed ${rows} rows`);
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({caseId,rows,insertedObservations,sources:sourceIds.size,entities:entityIds.size}));
} catch (e) {
  await client.query('ROLLBACK'); throw e;
} finally { await client.end(); }
