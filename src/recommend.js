// Paste-a-link recommendation engine.
//
// The customer drops a profile/post URL on the home screen and the panel answers two questions:
//   "which platform is this?"  -> from the hostname, then the path, then loose keywords
//   "which service should I use?" -> a scoring function over the platform's catalogue
//
// Nothing here calls the network or the database: it is a pure function over the cached catalog,
// so it is instant, cacheable and unit-testable. Two rules it never breaks:
//   1. Customer-facing KES only. Provider rates never leave the server (we score on price_cents
//      produced by pricing.rateCentsPer1000, never on s.rate).
//   2. The link itself is never logged or stored. Only the platform we inferred is returned.

const platforms = require('./platforms');
const pricing = require('./pricing');
const { getTypeDef } = require('./serviceTypes');

// Hostname -> platform key. Longest/most specific patterns first; matched as a suffix so
// "www.instagram.com" and "m.instagram.com" both hit the same rule.
const DOMAINS = [
  ['instagram.com', 'instagram'], ['instagr.am', 'instagram'],
  ['tiktok.com', 'tiktok'], ['vt.tiktok.com', 'tiktok'],
  ['youtube.com', 'youtube'], ['youtu.be', 'youtube'], ['music.youtube.com', 'youtube'],
  ['facebook.com', 'facebook'], ['fb.watch', 'facebook'], ['fb.me', 'facebook'], ['m.facebook.com', 'facebook'],
  ['twitter.com', 'twitter'], ['x.com', 'twitter'], ['t.co', 'twitter'],
  ['telegram.me', 'telegram'], ['t.me', 'telegram'], ['telegram.org', 'telegram'], ['telegram.dog', 'telegram'],
  ['wa.me', 'whatsapp'], ['api.whatsapp.com', 'whatsapp'], ['chat.whatsapp.com', 'whatsapp'], ['whatsapp.com', 'whatsapp'],
  ['spotify.com', 'spotify'], ['open.spotify.com', 'spotify'],
  ['soundcloud.com', 'soundcloud'], ['on.soundcloud.com', 'soundcloud'],
  ['music.apple.com', 'applemusic'], ['itunes.apple.com', 'applemusic'],
  ['audiomack.com', 'audiomack'],
  ['boomplay.com', 'boomplay'],
  ['deezer.com', 'deezer'],
  ['shazam.com', 'shazam'],
  ['snapchat.com', 'snapchat'],
  ['linkedin.com', 'linkedin'], ['lnkd.in', 'linkedin'],
  ['pinterest.com', 'pinterest'], ['pin.it', 'pinterest'],
  ['reddit.com', 'reddit'], ['redd.it', 'reddit'],
  ['discord.com', 'discord'], ['discord.gg', 'discord'],
  ['twitch.tv', 'twitch'],
  ['threads.net', 'threads'], ['threads.com', 'threads'],
  ['vimeo.com', 'vimeo'],
  ['dailymotion.com', 'dailymotion'], ['dai.ly', 'dailymotion'],
  ['clubhouse.com', 'clubhouse'],
  ['g.co', 'google'], ['goo.gl', 'google'], ['maps.google.com', 'google'], ['maps.app.goo.gl', 'google'],
  ['google.com', 'google'], ['play.google.com', 'google'],
  ['opensea.io', 'crypto'], ['coinmarketcap.com', 'crypto'], ['coingecko.com', 'crypto'],
  ['dextools.io', 'crypto'], ['rarible.com', 'crypto'],
  ['bigo.tv', 'other'], ['likee.video', 'other'], ['kwai.com', 'other'], ['tumblr.com', 'other'],
  ['bsky.app', 'other'], ['dribbble.com', 'other'], ['vk.com', 'other'], ['ok.ru', 'other'],
  ['tidal.com', 'other'], ['napster.com', 'other'], ['mixcloud.com', 'other'],
];

// Path hints that beat a bare hostname (a Google Maps link, a YouTube live URL, ...).
const PATH_HINTS = [
  [/\/maps/i, 'google'],
  [/\/play\/store|\/store\/apps/i, 'google'],
  [/\/watch\?v=|shorts\//i, 'youtube'],
  [/\/reel|instagram\.com\/(p|reel)\//i, 'instagram'],
  [/channel\/|invite\//i, 'discord'],
];

// Loose keywords, used when there is no URL at all ("instagram @name", "my tiktok").
const WORD_HINTS = [
  [/\binstagram|\binsta\b|\big\b/i, 'instagram'],
  [/\btik\s?tok\b/i, 'tiktok'],
  [/\byoutube|\byoutu\b|\byshorts\b/i, 'youtube'],
  [/\bfacebook|\bfb\b/i, 'facebook'],
  [/\btwitter|\bx\.com\b|\btweet/i, 'twitter'],
  [/\btelegram|\bt\.me\b/i, 'telegram'],
  [/\bwhats\s?app/i, 'whatsapp'],
  [/\bspotify\b/i, 'spotify'],
  [/\bsound\s?cloud/i, 'soundcloud'],
  [/\bapple\s?music/i, 'applemusic'],
  [/\bdeezer\b/i, 'deezer'],
  [/\bshazam\b/i, 'shazam'],
  [/\bsnapchat\b/i, 'snapchat'],
  [/\blinked\s?in/i, 'linkedin'],
  [/\bpinterest\b/i, 'pinterest'],
  [/\breddit\b/i, 'reddit'],
  [/\bdiscord\b/i, 'discord'],
  [/\btwitch\b/i, 'twitch'],
  [/\bthreads\b/i, 'threads'],
  [/\bvimeo\b/i, 'vimeo'],
  [/\bwebsite|\bseo\b|\bbacklink/i, 'webseo'],
];

// What is the customer actually trying to buy? The shape of the URL usually says it: a profile
// link wants followers, a post/reel wants likes or views, a video wants views, a channel wants
// members. When it is ambiguous they can pick a goal by hand and we filter.
const GOALS = [
  { key: 'followers', label: 'Followers', match: /follower|subscriber|subs\b|member|join|listener/i },
  { key: 'likes', label: 'Likes', match: /like|reaction|favourite|favorite|star\b/i },
  { key: 'views', label: 'Views', match: /view|play|impression|watch|stream|reach/i },
  { key: 'comments', label: 'Comments', match: /comment|reply|mention/i },
];

const GOAL_KEYS = GOALS.map((g) => g.key);
const goalByKey = (key) => GOALS.find((g) => g.key === key) || null;

/** Guess the goal from the URL shape. Returns a goal key or null when it is genuinely unclear. */
function inferGoal(input) {
  const raw = String(input || '').trim();
  const lower = raw.toLowerCase();
  let path = '';
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
    path = new URL(withScheme).pathname.toLowerCase();
  } catch { /* keyword fallback below */ }

  if (/\/(p|reel|reels|tv)\//.test(path) || /\/status\//.test(path)) return 'views';
  if (/\/watch|youtu\.be|\/shorts|\/video\//.test(lower)) return 'views';
  if (/\/track\/|\/album\/|\/playlist\//.test(path)) return 'plays';
  if (/\bt\.me\//.test(lower) || /telegram/.test(lower)) return 'followers'; // channel members
  if (/\/channel\/|\/c\/|\/@/.test(path)) return 'followers'; // youtube/tiktok profile
  // A bare profile URL (one path segment) is a followers request; anything deeper is a post.
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 1 && !/^(p|reel|reels|tv|watch|shorts|video|status|explore|feed|home)$/.test(segments[0])) {
    return 'followers';
  }
  return null;
}

/** https://www.instagram.com/p/xyz?igsh=1 -> 'instagram'. Returns null when we cannot tell. */
function detectPlatform(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // 1. hostname
  let host = '';
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
    const url = new URL(withScheme);
    host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname + url.search;
    for (const [pattern, key] of PATH_HINTS) if (pattern.test(path)) return key;
  } catch { /* not a URL - fall through to keywords */ }

  if (host) {
    // most specific suffix wins: 'chat.whatsapp.com' before 'whatsapp.com'
    const hits = DOMAINS.filter(([d]) => host === d || host.endsWith(`.${d}`)).sort((a, b) => b[0].length - a[0].length);
    if (hits.length) return hits[0][1];
  }

  // 2. loose keywords anywhere in the text
  for (const [pattern, key] of WORD_HINTS) if (pattern.test(raw)) return key;
  return null;
}

/** Pull a short, safe host label for the "why" line, e.g. "instagram.com". */
function hostOf(input) {
  const raw = String(input || '').trim();
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '').slice(0, 60);
  } catch {
    return null;
  }
}

/**
 * Score one service for "cheapest that actually works".
 *
 * Price carries most of the weight (that is what was asked for), but a service that cannot take
 * a plain link, or that is priced per order (a flat package), is penalised so the top pick is
 * almost always an orderable per-1000 service.
 */
function scoreService(service, settings, ctx = {}) {
  const def = getTypeDef(service.type);
  const per1000 = pricing.rateCentsPer1000(service.rate, settings);
  const flat = Boolean(def.flat);
  const takesLink = def.fields.includes('link');
  const min = Number(service.min) || 0;
  const want = Number(ctx.quantity) || 0;

  const reasons = [];
  let score = 1000;

  // price: cheaper is better, but on a log scale so a 5x cheaper service does not dwarf quality
  const priceKey = flat ? per1000 * 4 : per1000; // a flat package is not comparable to /1000
  score -= Math.log10(Math.max(1, priceKey)) * 200;
  reasons.push(flat ? 'priced per package' : `${Math.round(per1000 / 100)} KSh per 1000`);

  if (!takesLink) { score -= 400; reasons.push('does not take a link'); }
  if (flat) score -= 60;

  // quality signals the provider actually publishes
  if (service.refill) { score += 55; reasons.push('refill guarantee'); }
  if (service.cancel) { score += 15; reasons.push('cancellable'); }
  const speed = String(service.speed || '').toLowerCase();
  if (/instant|0-|1-|fast|minute/.test(speed)) { score += 30; reasons.push(`starts ${service.speed}`); }
  else if (/hour/.test(speed)) score += 12;
  else if (/day/.test(speed)) score -= 20;
  const drop = Number(service.drop_rate);
  if (Number.isFinite(drop) && drop > 0) score -= Math.min(80, drop * 4);

  // if the customer already gave a quantity, a service that cannot serve it is useless
  if (want > 0) {
    if (min && want < min) { score -= 250; reasons.push(`minimum is ${min}`); }
    if (Number(service.max) && want > Number(service.max)) { score -= 250; reasons.push(`maximum is ${service.max}`); }
  }

  return { score: Math.round(score), per1000, flat, takesLink, reasons };
}

/**
 * Recommend services for a pasted link.
 * @returns {{ platform, detected, host, services: Array, alternatives: Array, note }}
 */
function recommend(input, catalogList, settings, opts = {}) {
  const key = detectPlatform(input);
  const host = hostOf(input);
  const limit = Math.min(6, Math.max(1, Number(opts.limit) || 3));

  const list = Array.isArray(catalogList) ? catalogList : [];
  const platform = key ? platforms.platformByKey(key) : null;

  const pool = key ? list.filter((s) => platforms.platformOf(s.category).key === key) : [];

  // Goal: explicit choice wins, otherwise infer it from the URL, otherwise leave it open.
  const wanted = GOAL_KEYS.includes(String(opts.goal || '').toLowerCase()) ? String(opts.goal).toLowerCase() : null;
  const inferred = wanted ? null : inferGoal(input);
  const goal = wanted || inferred;
  const goalDef = goalByKey(goal);

  let candidates = pool;
  let goalApplied = false;
  if (goalDef) {
    // Category strings are broad ("Instagram Followers & Engagement") and would happily match a
    // Saves service. When a service names its own goal, that name decides; the category is only
    // consulted for services that stay silent about it.
    const named = pool.filter((s) => goalDef.match.test(String(s.name || '')));
    const byCategory = pool.filter((s) => {
      if (GOALS.some((g) => g.key !== goal && g.match.test(String(s.name || '')))) return false;
      return goalDef.match.test(`${s.category} ${s.type}`);
    });
    const matched = named.length ? named : byCategory;
    if (matched.length) { candidates = matched; goalApplied = true; }
  }

  const cheapestFirst = String(opts.sort || '').toLowerCase() === 'price';
  const scored = candidates
    .map((s) => ({ service: s, ...scoreService(s, settings, opts) }))
    .filter((r) => r.takesLink)
    .sort((cheapestFirst
      ? (a, b) => a.per1000 - b.per1000 || b.score - a.score
      : (a, b) => b.score - a.score || a.per1000 - b.per1000));

  const services = scored.slice(0, limit).map((r) => ({
    id: r.service.id,
    name: r.service.name,
    category: r.service.category,
    type: r.service.type,
    per1000_cents: r.per1000,
    flat: r.flat,
    min: Number(r.service.min) || 0,
    max: Number(r.service.max) || 0,
    refill: Boolean(r.service.refill),
    speed: r.service.speed || null,
    score: r.score,
    reasons: r.reasons.slice(0, 3),
  }));

  // What else could this link be? Only when we are unsure, or so the customer can compare.
  const alternatives = platforms
    .platformList(list)
    .filter((p) => p.key !== key)
    .slice(0, 6)
    .map((p) => ({ key: p.key, name: p.name, color: p.color }));

  let note;
  const where = platform ? platform.name : key;
  const goalWord = goalApplied && goalDef ? ` for ${goalDef.label.toLowerCase()}` : '';
  if (!input || !String(input).trim()) note = 'Paste your profile, post or channel link.';
  else if (!key) note = 'We could not tell which platform that link belongs to. Pick one below.';
  else if (!pool.length) note = `We do not carry ${where} services right now — pick another platform.`;
  else if (!services.length) note = `Nothing on ${where} accepts a plain link — open the platform to see every service.`;
  else note = `Best value on ${where}${goalWord}${host ? ` for a link from ${host}` : ''}.`;

  return {
    detected: key || null,
    platform: platform ? { key: platform.key, name: platform.name, color: platform.color, count: pool.length } : null,
    host,
    goal: goalApplied ? goal : null,
    sort: cheapestFirst ? 'price' : 'value',
    goal_inferred: Boolean(inferred && goalApplied),
    goals: GOALS.map((g) => ({ key: g.key, label: g.label })),
    services,
    alternatives,
    note,
    // never echo the link back to logs; the client already has it
  };
}

module.exports = { recommend, detectPlatform, inferGoal, scoreService, hostOf, GOALS, DOMAINS, WORD_HINTS };
