#!/usr/bin/env node
// Local browse app for Entrata data.
//
//   node --env-file=.env scripts/browse.mjs
//   open http://localhost:3001
//
// Keeps the API key server-side; the browser only talks to this server.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3001);
const BASE_URL = process.env.ENTRATA_BASE_URL;
const API_KEY = process.env.ENTRATA_API_KEY;

if (!BASE_URL || !API_KEY) {
  console.error('Missing ENTRATA_BASE_URL or ENTRATA_API_KEY. Did you pass --env-file=.env?');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
};

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

// Simple in-memory TTL cache. Only used for the property list (changes rarely).
// Per-property fees are intentionally *not* cached so every selection hits Entrata fresh.
const cache = new Map();
async function memoize(key, ttlMs, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = await fn();
  cache.set(key, { value, expiresAt: now + ttlMs });
  return value;
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
      const list = await memoize('properties:list', 60 * 60 * 1000, async () => {
        const data = await entrata('properties', 'getProperties', {});
        const raw = data?.response?.result?.PhysicalProperty?.Property ?? [];
        return Array.isArray(raw) ? raw : [raw];
      });
      sendJson(res, 200, list);
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

    // Static file serving from project root. Only GET, only files under PROJECT_ROOT.
    if (req.method === 'GET' && url.pathname !== '/' && !url.pathname.startsWith('/api/')) {
      const requested = resolve(PROJECT_ROOT, '.' + url.pathname);
      if (!requested.startsWith(PROJECT_ROOT + '/') && requested !== PROJECT_ROOT) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      try {
        const s = await stat(requested);
        if (s.isFile()) {
          const ext = extname(requested).toLowerCase();
          const type = MIME[ext] || 'application/octet-stream';
          const body = await readFile(requested);
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
          res.end(body);
          return;
        }
      } catch { /* fall through to 404 */ }
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
