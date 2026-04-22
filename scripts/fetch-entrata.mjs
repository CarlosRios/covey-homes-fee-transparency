#!/usr/bin/env node
// Entrata API client + subcommands for the fee-transparency project.
//
// Run with Node 20.6+ (uses the built-in --env-file flag):
//   node --env-file=.env scripts/fetch-entrata.mjs discover
//   node --env-file=.env scripts/fetch-entrata.mjs fetch <propertyId>
//   node --env-file=.env scripts/fetch-entrata.mjs raw <resource> <method> [jsonParams]
//   node --env-file=.env scripts/fetch-entrata.mjs snapshot
//
// Env:
//   ENTRATA_BASE_URL  e.g. https://apis.entrata.com/ext/orgs/<orgs>/v1
//   ENTRATA_API_KEY   X-Api-Key header value

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.ENTRATA_BASE_URL;
const API_KEY = process.env.ENTRATA_API_KEY;

if (!BASE_URL || !API_KEY) {
  console.error('Missing ENTRATA_BASE_URL or ENTRATA_API_KEY. Did you pass --env-file=.env?');
  process.exit(1);
}

async function call(resource, methodName, params = {}, version) {
  const url = `${BASE_URL.replace(/\/$/, '')}/${resource}`;
  const body = {
    auth: { type: 'apikey' },
    requestId: randomUUID(),
    method: {
      name: methodName,
      ...(version ? { version } : {}),
      params,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Api-Key': API_KEY,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }

  if (!res.ok) {
    const snippet = text.slice(0, 800);
    throw new Error(`HTTP ${res.status} ${res.statusText} on ${resource}/${methodName}\n${snippet}`);
  }
  if (json?.response?.error) {
    const { code, message } = json.response.error;
    throw new Error(`Entrata error ${code} on ${resource}/${methodName}: ${message}`);
  }
  return json;
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

async function discover() {
  console.log('Calling properties/getProperties (no filter)...\n');
  const res = await call('properties', 'getProperties', {});
  const list = asArray(res?.response?.result?.PhysicalProperty?.Property);
  console.log(`Found ${list.length} properties:\n`);
  for (const p of list) {
    const a = p.Address || {};
    const addr = [a.Address, [a.City, a.State].filter(Boolean).join(', '), a.PostalCode]
      .filter(Boolean).join(' · ');
    const disabled = p.IsDisabled === '1' || p.IsDisabled === 1 ? ' [DISABLED]' : '';
    const id = String(p.PropertyID ?? p.propertyId ?? '').padEnd(8);
    console.log(`  ${id}  ${p.MarketingName ?? '(no name)'}${disabled}`);
    if (addr) console.log(`            ${addr}`);
  }
  return list;
}

async function fetchAll(propertyId) {
  if (!propertyId) throw new Error('fetch requires a propertyId (run `discover` to find it)');
  const pid = String(propertyId);
  console.log(`Fetching everything for propertyId=${pid}...`);

  const tasks = [
    ['property',         () => call('properties',    'getProperties',       { propertyIds: pid })],
    ['propertyFees',     () => call('pricing',       'getPropertyFees',     { propertyId: pid })],
    ['floorPlans',       () => call('properties',    'getFloorPlans',       { propertyId: Number(pid) })],
    ['unitTypes',        () => call('propertyunits', 'getUnitTypes',        { propertyId: Number(pid) })],
    ['petTypes',         () => call('properties',    'getPetTypes',         { propertyIds: pid })],
    ['rentableItems',    () => call('properties',    'getRentableItems',    { propertyId: Number(pid) })],
    ['pricingPicklists', () => call('pricing',       'getPricingPicklists', {}, 'r1')],
  ];

  const out = { __fetchedAt: new Date().toISOString(), __propertyId: pid };
  await Promise.all(tasks.map(async ([k, fn]) => {
    try {
      out[k] = await fn();
      console.log(`  ✓ ${k}`);
    } catch (e) {
      out[k] = { __error: e.message };
      console.log(`  ✗ ${k} — ${e.message.split('\n')[0]}`);
    }
  }));

  const path = 'scripts/entrata-debug.json';
  await writeFile(path, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${path}`);
}

async function raw(resource, method, paramsJson) {
  if (!resource || !method) {
    throw new Error('usage: raw <resource> <method> [jsonParams]');
  }
  const params = paramsJson ? JSON.parse(paramsJson) : {};
  const res = await call(resource, method, params);
  console.log(JSON.stringify(res, null, 2));
}

// Fetch all properties + their fees/floor plans and write a static JSON snapshot.
// Used by GitHub Actions to publish data the static site can fetch without a server.
async function snapshot() {
  console.log('Building static snapshot…\n');

  // Step 1: get full property list
  const listRes = await call('properties', 'getProperties', {});
  const allProps = asArray(listRes?.response?.result?.PhysicalProperty?.Property);
  console.log(`Found ${allProps.length} properties. Fetching fees + floor plans for each…\n`);

  const properties = [];

  for (const prop of allProps) {
    const pid = String(prop.PropertyID ?? prop.propertyId ?? '');
    const name = prop.MarketingName || `Property ${pid}`;
    process.stdout.write(`  ${name.padEnd(40)} `);

    const tasks = await Promise.allSettled([
      call('properties', 'getFloorPlans', { propertyId: Number(pid) }),
      call('pricing',    'getPropertyFees', { propertyId: pid }),
    ]);
    const pick = (r) => r.status === 'fulfilled' ? r.value : { __error: r.reason.message, __code: r.reason.code };
    const [fpRes, feesRes] = tasks.map(pick);

    const floorPlans = fpRes?.response?.result?.FloorPlans?.FloorPlan ?? fpRes;
    const fees = feesRes?.response?.result ?? feesRes;

    const noFees = feesRes?.__code === 310 || feesRes?.__error?.includes('310');
    process.stdout.write(noFees ? '(no fees)\n' : '✓\n');

    properties.push({
      PropertyID: prop.PropertyID,
      MarketingName: prop.MarketingName,
      IsDisabled: prop.IsDisabled,
      Address: prop.Address,
      floorPlans,
      fees,
    });
  }

  const snapshot = {
    __generatedAt: new Date().toISOString(),
    __propertyCount: properties.length,
    properties,
  };

  const outPath = 'data/entrata-snapshot.json';
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`\nWrote ${outPath}  (${properties.length} properties)`);
}

const [cmd, ...args] = process.argv.slice(2);

try {
  switch (cmd) {
    case 'discover':  await discover();                          break;
    case 'fetch':     await fetchAll(args[0]);                   break;
    case 'raw':       await raw(args[0], args[1], args[2]);      break;
    case 'snapshot':  await snapshot();                          break;
    default:
      console.log(`Usage:
  node --env-file=.env scripts/fetch-entrata.mjs discover
  node --env-file=.env scripts/fetch-entrata.mjs fetch <propertyId>
  node --env-file=.env scripts/fetch-entrata.mjs raw <resource> <method> [jsonParams]
  node --env-file=.env scripts/fetch-entrata.mjs snapshot

Examples:
  node --env-file=.env scripts/fetch-entrata.mjs discover
  node --env-file=.env scripts/fetch-entrata.mjs fetch 12345
  node --env-file=.env scripts/fetch-entrata.mjs raw pricing getPricingPicklists
  node --env-file=.env scripts/fetch-entrata.mjs snapshot`);
  }
} catch (e) {
  console.error(`\nError: ${e.message}`);
  process.exit(1);
}
