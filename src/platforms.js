// Platform grouping for the order flow.
//
// The provider catalog (smm.africa) gives us a free-text `category` per service and no
// `platform` field at all: "📺Vimeo", "Facebook FRANCE (Page Followers & Post Likes) 🇫🇷",
// "🔷 Telegram Members", "Instagram Followers [CHEAP]". This module maps those strings onto a
// small, stable set of platforms so the panel can ask "which platform?" first.
//
// Matching is substring based and order-sensitive: the first pattern that hits wins, so
// specific names ("apple music") must be listed before generic ones ("music").

const PLATFORMS = [
  { key: 'instagram', name: 'Instagram', color: '#E1306C', match: ['instagram', 'insta '] },
  { key: 'tiktok', name: 'TikTok', color: '#25F4EE', match: ['tiktok', 'tik tok'] },
  { key: 'youtube', name: 'YouTube', color: '#FF0033', match: ['youtube', 'youtu.be'] },
  { key: 'facebook', name: 'Facebook', color: '#1877F2', match: ['facebook', 'fb '] },
  { key: 'twitter', name: 'X / Twitter', color: '#e7e9ea', match: ['twitter', 'x.com'] },
  { key: 'telegram', name: 'Telegram', color: '#2AABEE', match: ['telegram'] },
  { key: 'whatsapp', name: 'WhatsApp', color: '#25D366', match: ['whatsapp', 'whats app'] },
  { key: 'spotify', name: 'Spotify', color: '#1DB954', match: ['spotify'] },
  { key: 'soundcloud', name: 'SoundCloud', color: '#FF7700', match: ['soundcloud', 'sound cloud'] },
  { key: 'applemusic', name: 'Apple Music', color: '#FA243C', match: ['apple music'] },
  { key: 'audiomack', name: 'Audiomack', color: '#FFA200', match: ['audiomack', 'audio mack'] },
  { key: 'boomplay', name: 'Boomplay', color: '#FF5A00', match: ['boomplay'] },
  { key: 'deezer', name: 'Deezer', color: '#A238FF', match: ['deezer'] },
  { key: 'shazam', name: 'Shazam', color: '#0088FF', match: ['shazam'] },
  { key: 'snapchat', name: 'Snapchat', color: '#FFFC00', match: ['snapchat'] },
  { key: 'linkedin', name: 'LinkedIn', color: '#0A66C2', match: ['linkedin'] },
  { key: 'pinterest', name: 'Pinterest', color: '#E60023', match: ['pinterest'] },
  { key: 'reddit', name: 'Reddit', color: '#FF4500', match: ['reddit'] },
  { key: 'discord', name: 'Discord', color: '#5865F2', match: ['discord'] },
  { key: 'twitch', name: 'Twitch', color: '#9146FF', match: ['twitch'] },
  { key: 'threads', name: 'Threads', color: '#e7e9ea', match: ['threads'] },
  { key: 'vimeo', name: 'Vimeo', color: '#1AB7EA', match: ['vimeo'] },
  { key: 'dailymotion', name: 'Dailymotion', color: '#00AAFF', match: ['daily motion', 'dailymotion'] },
  { key: 'clubhouse', name: 'Clubhouse', color: '#F7C948', match: ['club house', 'clubhouse'] },
  { key: 'google', name: 'Google', color: '#4285F4', match: ['google maps', 'google play', 'google business', 'google reviews', 'google'] },
  { key: 'crypto', name: 'Crypto & Web3', color: '#F7931A', match: ['opensea', 'coinmarket', 'coingecko', 'dextools', 'crypto', 'rarible'] },
  { key: 'webseo', name: 'Website & SEO', color: '#7EA7D8', match: ['website', 'seo', 'backlink', 'traffic', 'visits', 'press release', 'app install', 'application install', 'referrer'] },
  { key: 'other', name: 'Other', color: '#8ea3be', match: ['bigo', 'likee', 'kuaishou', 'tumblr', 'bluesky', 'dribbble', 'dzen', 'dolap', 'vk ', 'ok.ru', 'napster', 'tidal', 'mixcloud', 'afreeca', 'tiktok live', 'kwai'] },
];

const FALLBACK = { key: 'other', name: 'Other', color: '#8ea3be', match: [] };

/** Map a provider category string onto a platform record. */
function platformOf(category) {
  const c = String(category || '').toLowerCase();
  for (const p of PLATFORMS) {
    if (p.match.some((m) => c.includes(m))) return p;
  }
  return FALLBACK;
}

const platformByKey = (key) => PLATFORMS.find((p) => p.key === key) || null;

/** [{key,name,color,count}] for every platform present in the catalog, biggest first. */
function platformList(list) {
  const counts = new Map();
  for (const s of list) {
    const p = platformOf(s.category);
    counts.set(p.key, (counts.get(p.key) || 0) + 1);
  }
  const seen = new Set();
  const out = [];
  for (const p of PLATFORMS) {
    if (seen.has(p.key)) continue;
    const count = counts.get(p.key) || 0;
    if (!count) continue;
    seen.add(p.key);
    out.push({ key: p.key, name: p.name, color: p.color, count });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

module.exports = { PLATFORMS, platformOf, platformByKey, platformList };
