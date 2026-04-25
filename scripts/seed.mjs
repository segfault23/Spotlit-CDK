// One-off seeder: reads spotlit/src/lib/data.js, transforms FEATURES + PRESETS
// into DDB items, and writes them to the SpotlitContent table.
//
// Idempotent: uses PutItem so re-running overwrites existing items (version
// counter increments are handled by the app's write path, not this script).
//
// Usage:
//   node "Spotlit CDK/scripts/seed.mjs"
//
// Requires:
//   - AWS credentials configured (same ones cdk uses)
//   - Table name discovered from the deployed CloudFormation stack output

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STACK_NAME = 'SpotlitCdkStack';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-west-2';

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')      // strip apostrophes
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function discoverTableName() {
  const cf = new CloudFormationClient({ region: REGION });
  const out = await cf.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  const outputs = out.Stacks?.[0]?.Outputs ?? [];
  const found = outputs.find(o => o.OutputKey === 'ContentTableName');
  if (!found?.OutputValue) throw new Error(`Stack ${STACK_NAME} has no ContentTableName output`);
  return found.OutputValue;
}

function transformFeatures(FEATURES) {
  const now = Date.now();
  return Object.entries(FEATURES).map(([name, f]) => {
    const slug = slugify(name);
    return {
      pk: `FEATURE#${slug}`,
      sk: 'META',
      gsi1pk: 'feature',
      gsi1sk: name,
      entity: 'feature',
      slug,
      name,
      type: f.t,
      cost: f.cost ?? '',
      body: f.tx,
      variables: [],          // none declared yet; legacy inline vars stay in `body`
      tags: [],
      meta: {},
      source: 'builtin',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
  });
}

function transformCreatures(PRESETS) {
  const now = Date.now();
  return Object.entries(PRESETS).map(([name, p]) => {
    const slug = slugify(name);
    return {
      pk: `CREATURE#${slug}`,
      sk: 'META',
      gsi1pk: 'creature',
      gsi1sk: name,
      entity: 'creature',
      slug,
      name,
      // Stat fields preserved from the original presets shape so the app can
      // continue to consume them with no field renames.
      type: p.type,
      tier: p.tier,
      diff: p.diff,
      hp: p.hp,
      str: p.str,
      atk: p.atk,
      thresh: p.thresh,
      dmg: p.dmg,
      atkName: p.atkName,
      // Keep the legacy "Name|note" string format. The pipe override syntax
      // is preserved exactly as it was in data.js.
      feats: p.feats,
      tags: [],
      meta: {},
      source: 'builtin',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
  });
}

async function batchWrite(ddb, tableName, items) {
  // BatchWriteItem allows up to 25 requests per call.
  const CHUNK = 25;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const cmd = new BatchWriteCommand({
      RequestItems: {
        [tableName]: chunk.map(Item => ({ PutRequest: { Item } })),
      },
    });
    let res = await ddb.send(cmd);
    // Retry any unprocessed items (DDB throttling / size limits).
    let attempts = 0;
    while (res.UnprocessedItems && Object.keys(res.UnprocessedItems).length && attempts < 5) {
      attempts++;
      await new Promise(r => setTimeout(r, 200 * attempts));
      res = await ddb.send(new BatchWriteCommand({ RequestItems: res.UnprocessedItems }));
    }
    if (res.UnprocessedItems && Object.keys(res.UnprocessedItems).length) {
      throw new Error(`Failed to write all items after retries (chunk starting at ${i})`);
    }
  }
}

async function main() {
  // seed-data.local.mjs is gitignored; gameplay content lives in DynamoDB.
  // Keep your editable copy at Spotlit CDK/scripts/seed-data.local.mjs.
  const dataPath = resolve(__dirname, 'seed-data.local.mjs');
  const { FEATURES, PRESETS } = await import(pathToFileURL(dataPath).href);

  const features = transformFeatures(FEATURES);
  const creatures = transformCreatures(PRESETS);
  console.log(`Loaded ${features.length} features and ${creatures.length} creatures from seed-data.local.mjs`);

  const tableName = await discoverTableName();
  console.log(`Target table: ${tableName} (${REGION})`);

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  console.log('Writing features...');
  await batchWrite(ddb, tableName, features);
  console.log('Writing creatures...');
  await batchWrite(ddb, tableName, creatures);

  console.log(`Done. Wrote ${features.length + creatures.length} items.`);
}

main().catch(err => { console.error(err); process.exit(1); });
