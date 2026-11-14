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

// An unknown id is normally a stale bookmark or a typo. Asking the supplier again to be sure costs a
// round-trip (~7s on a slow day), so it is only worth doing when the catalogue we hold is itself old.
const STALE_ENOUGH_MS = 60 * 1000;

async function getService(id) {
  const numeric = Number(id);
  if (!Number.isFinite(numeric)) return null;
  const c = await load();
  const hit = c.byId.get(numeric);
  if (hit) return hit;
  // The catalogue was refreshed a moment ago (load() refreshes when its TTL expires), so the id
  // really is not on offer. Answer at once instead of holding the click for a supplier round-trip.
  if (Date.now() - Number(c.at || 0) < STALE_ENOUGH_MS) return null;
  const fresh = await load(true);
  return fresh.byId.get(numeric) || null;
}

const clear = () => {
  cache = { at: 0, list: [], byId: new Map() };
};

module.exports = { load, getService, clear, TTL_MS };
