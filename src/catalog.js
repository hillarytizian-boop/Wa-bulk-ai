// Cached copy of the provider's service catalog (rates, limits and IDs change over time).
const smm = require('./smm');

const TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, list: [], byId: new Map() };
let inflight = null;

const truthy = (v) => v === true || v === 1 || v === 'true' || v === 'yes';

function normalize(s) {
  return {
    id: Number(s.service),
    name: String(s.name || ''),
    type: String(s.type || 'Default'),
    rate: Number(s.rate) || 0, // USD per 1000 units (per order for flat types)
    min: Number(s.min) || 0,
    max: Number(s.max) || 0,
    category: String(s.category || 'Other'),
    description: String(s.description || ''),
    refill: truthy(s.refill),
    cancel: truthy(s.cancel),
    dropRate: s.drop_rate != null ? String(s.drop_rate) : '',
    startTime: s.start_time != null ? String(s.start_time) : '',
    speed: s.speed != null ? String(s.speed) : '',
    reliability: s.reliability != null ? String(s.reliability) : '',
  };
}

async function load(force = false) {
  if (!force && cache.list.length && Date.now() - cache.at < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const data = await smm.services();
    const raw = Array.isArray(data) ? data : Array.isArray(data && data.services) ? data.services : [];
    const list = raw.map(normalize).filter((s) => Number.isFinite(s.id) && s.id > 0);
    const byId = new Map(list.map((s) => [s.id, s]));
    cache = { at: Date.now(), list, byId };
    return cache;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function getService(id) {
  const numeric = Number(id);
  if (!Number.isFinite(numeric)) return null;
  const c = await load();
  const hit = c.byId.get(numeric);
  if (hit) return hit;
  // Catalog may be stale: refresh once before declaring the service missing.
  const fresh = await load(true);
  return fresh.byId.get(numeric) || null;
}

const clear = () => {
  cache = { at: 0, list: [], byId: new Map() };
};

module.exports = { load, getService, clear, TTL_MS };
