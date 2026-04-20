#!/usr/bin/env node
// Local browse app for Entrata data.
//
//   node --env-file=.env scripts/browse.mjs
//   open http://localhost:3001
//
// Keeps the API key server-side; the browser only talks to this server.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3001);
const BASE_URL = process.env.ENTRATA_BASE_URL;
const API_KEY = process.env.ENTRATA_API_KEY;

if (!BASE_URL || !API_KEY) {
  console.error('Missing ENTRATA_BASE_URL or ENTRATA_API_KEY. Did you pass --env-file=.env?');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

async function entrata(resource, methodName, params = {}, version) {
  const url = `${BASE_URL.replace(/\/$/, '')}/${resource}`;
  const body = {
    auth: { type: 'apikey' },
    requestId: randomUUID(),
    method: { name: methodName, ...(version ? { version } : {}), params },
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
  if (!res.ok || json?.response?.error) {
    const msg = json?.response?.error?.message || `HTTP ${res.status} ${text.slice(0, 300)}`;
    const code = json?.response?.error?.code || res.status;
    const err = new Error(msg);
    err.code = code;
    throw err;
  }
  return json;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// Entrata takes dates in MM/DD/YYYY. The HTML date input gives YYYY-MM-DD.
function isoToUsDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(join(__dirname, 'browse.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url.pathname === '/api/properties') {
      const data = await entrata('properties', 'getProperties', {});
      const list = data?.response?.result?.PhysicalProperty?.Property ?? [];
      sendJson(res, 200, Array.isArray(list) ? list : [list]);
      return;
    }

    const m = url.pathname.match(/^\/api\/property\/(\d+)$/);
    if (m) {
      const pid = m[1];
      const moveInIso = url.searchParams.get('moveIn'); // YYYY-MM-DD
      const moveIn = moveInIso ? isoToUsDate(moveInIso) : null; // MM/DD/YYYY

      const tasks = [
        entrata('properties',    'getProperties',    { propertyIds: pid }),
        entrata('properties',    'getFloorPlans',    { propertyId: Number(pid) }),
        entrata('propertyunits', 'getPropertyUnits', { propertyIds: pid, availableUnitsOnly: '0', includeDisabledFloorplans: '0', includeDisabledUnits: '0' }),
        entrata('pricing',       'getPropertyFees',  { propertyId: pid }),
      ];
      if (moveIn) {
        tasks.push(entrata('propertyunits', 'getUnitsAvailabilityAndPricing', {
          propertyId: Number(pid),
          availableUnitsOnly: '0',
          unavailableUnitsOnly: '0',
          skipPricing: '0',
          showUnitSpaces: '1',
          includeDisabledFloorplans: '0',
          includeDisabledUnits: '0',
          moveInStartDate: moveIn,
          moveInEndDate: moveIn,
        }, 'r1'));
      }
      const settled = await Promise.allSettled(tasks);
      const pick = (r) => r.status === 'fulfilled' ? r.value : { __error: r.reason.message, __code: r.reason.code };
      const [prop, fp, units, fees, pricing] = settled.map(pick);

      sendJson(res, 200, {
        property: prop?.response?.result?.PhysicalProperty?.Property ?? prop,
        floorPlans: fp?.response?.result?.FloorPlans?.FloorPlan ?? fp,
        units: units?.response?.result?.properties?.property ?? units,
        fees: fees?.response?.result ?? fees,
        livePricing: moveIn ? (pricing?.response?.result ?? pricing) : null,
        moveIn: moveInIso || null,
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    sendJson(res, 500, { error: e.message, code: e.code });
  }
});

server.listen(PORT, () => {
  console.log(`Browsing Entrata data for ${BASE_URL}`);
  console.log(`→ http://localhost:${PORT}`);
});
