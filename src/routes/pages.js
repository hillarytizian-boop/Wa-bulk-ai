// Server-rendered pages that must be readable by crawlers and by link previews.
//
// The customer app is a hash-routed SPA, so every URL is really "/" and a crawler sees one page.
// These routes give each popular search phrase its own real HTML page with real prices, and a
// dynamic sitemap that lists them. Nothing here needs a session, and nothing here is inline
// scripted, so the CSP stays exactly as strict as it is for the app.
//
// Prices come from the same catalog + pricing module the SPA uses, so a page can never advertise a
// price the order form will not honour.
const express = require('express');
const config = require('../config');
const catalog = require('../catalog');
const pricing = require('../pricing');
const { wrap } = require('../errors');

const router = express.Router();
const BASE = (process.env.PUBLIC_URL || config.publicUrl || 'https://hilapanel.vercel.app').replace(/\/$/, '');

const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const kes = (n) => `KSh ${Math.round(Number(n) || 0).toLocaleString('en-KE')}`;

/**
 * Match a landing page to provider services.
 *
 * The provider's category is occasionally broader than the service name ("Threads Followers" filed
 * under Instagram), so the NAME decides whenever it names any platform at all; the category is only
 * consulted for services whose name mentions no platform.
 */
const PLATFORM_TOKEN = /instagram|tiktok|youtube|facebook|twitter|telegram|spotify|threads|\bx\b/i;
const onPlatform = (nameRe, kindRe) => (s) => {
  const text = PLATFORM_TOKEN.test(s.name) ? s.name : `${s.name} ${s.category}`;
  return nameRe.test(text) && kindRe.test(text);
};

/**
 * Each page: the search intent, the words it has to contain, and how to find matching services in
 * the provider catalog (matched on lower-cased service name + category).
 */
const LANDINGS = [
  {
    slug: 'buy-instagram-followers-kenya',
    h1: 'Buy Instagram followers in Kenya',
    title: 'Buy Instagram Followers in Kenya | M-Pesa | smmpanel',
    description: 'Real Instagram followers from KSh 60. Pay with M-Pesa, delivery starts in minutes. Refill where the provider offers it.',
    intro: 'Followers delivered to your username, priced per 1000 and paid with M-Pesa. Cheapest options are listed first.',
    match: onPlatform(/instagram/i, /follower/i),
    qtyLabel: 'followers',
    faq: [
      ['Do I need to give my password?', 'No. Orders only need your public username or the post link, so nobody ever signs in to your account.'],
      ['How fast do followers arrive?', 'Most Instagram follower services start within minutes and finish inside the delivery window shown on the order.'],
      ['What if followers drop?', 'Where the provider offers a refill, the order card shows a Refill button and we re-deliver the missing amount at no cost.'],
    ],
  },
  {
    slug: 'buy-instagram-likes-kenya',
    h1: 'Buy Instagram likes in Kenya',
    title: 'Buy Instagram Likes in Kenya | M-Pesa | smmpanel',
    description: 'Instagram likes from KSh 60 per order. Pay with M-Pesa and get delivery started in minutes.',
    intro: 'Likes on any public post or reel. Paste the post link, choose the amount, pay with M-Pesa.',
    match: onPlatform(/instagram/i, /like/i),
    qtyLabel: 'likes',
    faq: [
      ['Which link do I paste?', 'The link to the post itself (instagram.com/p/… or /reel/…). A profile link cannot receive likes.'],
      ['Can I split likes across posts?', 'One order covers one post. Place separate orders, or use the mass order screen, for several posts.'],
    ],
  },
  {
    slug: 'buy-instagram-views-kenya',
    h1: 'Buy Instagram views in Kenya',
    title: 'Buy Instagram Views & Reel Plays in Kenya | smmpanel',
    description: 'Instagram reel and video views from KSh 60. M-Pesa checkout, delivery in minutes.',
    intro: 'Views on reels and videos, priced per 1000 and paid with M-Pesa.',
    match: onPlatform(/instagram/i, /view|play/i),
    qtyLabel: 'views',
    faq: [
      ['Do views work on reels?', 'Yes - choose a service that says Reels in its name if you only want reel plays.'],
      ['Is this safe for my account?', 'No password is ever needed, so there is nothing for the platform to flag as a login.'],
    ],
  },
  {
    slug: 'buy-tiktok-followers-kenya',
    h1: 'Buy TikTok followers in Kenya',
    title: 'Buy TikTok Followers in Kenya | M-Pesa | smmpanel',
    description: 'TikTok followers from KSh 60. Pay with M-Pesa, delivery starts in minutes.',
    intro: 'Followers for any public TikTok profile, priced per 1000 and paid with M-Pesa.',
    match: onPlatform(/tiktok/i, /follower/i),
    qtyLabel: 'followers',
    faq: [
      ['Do you need my TikTok login?', 'No. Orders only need your public @username.'],
      ['Can I order for someone else?', 'Yes, as long as the account is public - paste its username.'],
    ],
  },
  {
    slug: 'buy-tiktok-views-kenya',
    h1: 'Buy TikTok views in Kenya',
    title: 'Buy TikTok Video Views in Kenya | smmpanel',
    description: 'TikTok video views from KSh 60. M-Pesa checkout, delivery in minutes.',
    intro: 'Views on any public TikTok video, priced per 1000 and paid with M-Pesa.',
    match: onPlatform(/tiktok/i, /view|play/i),
    qtyLabel: 'views',
    faq: [
      ['Which link do I paste?', 'The video link (tiktok.com/@user/video/…) - not the profile link.'],
      ['How fast do views arrive?', 'Usually within minutes; the order card shows the live remaining count.'],
    ],
  },
  {
    slug: 'buy-youtube-subscribers-kenya',
    h1: 'Buy YouTube subscribers in Kenya',
    title: 'Buy YouTube Subscribers in Kenya | M-Pesa | smmpanel',
    description: 'YouTube subscribers from KSh 60. Pay with M-Pesa, delivery starts in minutes.',
    intro: 'Subscribers for any public channel, priced per 1000 and paid with M-Pesa.',
    match: onPlatform(/youtube/i, /subscriber|subs\b/i),
    qtyLabel: 'subscribers',
    faq: [
      ['Will this get my channel removed?', 'We only sell services the provider has flagged for refill or stability. Growth through third parties carries risk, which the Terms describe - use services that fit your channel.'],
      ['Do you need channel access?', 'No. A public channel link is enough.'],
    ],
  },
  {
    slug: 'buy-youtube-views-kenya',
    h1: 'Buy YouTube views in Kenya',
    title: 'Buy YouTube Views in Kenya | M-Pesa | smmpanel',
    description: 'YouTube video views from KSh 60. M-Pesa checkout, delivery in minutes.',
    intro: 'Views on any public YouTube video, priced per 1000 and paid with M-Pesa.',
    match: onPlatform(/youtube/i, /view/i),
    qtyLabel: 'views',
    faq: [
      ['Do views count towards monetisation?', 'No. Third-party views do not count towards YouTube monetisation requirements, and the Terms say so.'],
      ['Can I order watch hours?', 'Yes - search "watch time" in the panel; they are on the YouTube category.'],
    ],
  },
  {
    slug: 'buy-facebook-page-likes-kenya',
    h1: 'Buy Facebook page likes in Kenya',
    title: 'Buy Facebook Page Likes & Followers in Kenya | smmpanel',
    description: 'Facebook page likes and followers from KSh 60. Pay with M-Pesa.',
    intro: 'Page likes, followers, post likes and reactions for public pages, priced per 1000 and paid with M-Pesa.',
    match: onPlatform(/facebook/i, /like|follower|page/i),
    qtyLabel: 'likes',
    faq: [
      ['Do you need admin access?', 'No. A public page link is enough.'],
      ['Are these real accounts?', 'They are provider-supplied accounts, not an ad campaign. For reach into real audiences, use Meta ads.'],
    ],
  },
  {
    slug: 'buy-x-followers-kenya',
    h1: 'Buy X (Twitter) followers in Kenya',
    title: 'Buy X / Twitter Followers in Kenya | smmpanel',
    description: 'X (Twitter) followers and likes from KSh 60. M-Pesa checkout.',
    intro: 'Followers, likes and views for public X profiles, priced per 1000 and paid with M-Pesa.',
    match: onPlatform(/twitter|\bx\b/i, /follower|like|view|retweet|repost/i),
    qtyLabel: 'followers',
    faq: [
      ['Does it work for the new X?', 'Yes - the provider services still refer to it as Twitter; the profile is the same one.'],
    ],
  },
  {
    slug: 'buy-telegram-members-kenya',
    h1: 'Buy Telegram channel members in Kenya',
    title: 'Buy Telegram Members & Views in Kenya | smmpanel',
    description: 'Telegram channel members and post views from KSh 60. Pay with M-Pesa.',
    intro: 'Members for public groups and channels, priced per 1000 and paid with M-Pesa.',
    match: onPlatform(/telegram/i, /./),
    qtyLabel: 'members',
    faq: [
      ['Public or private channels?', 'Public channels and groups only - a private invite link cannot receive members.'],
    ],
  },
  {
    slug: 'buy-spotify-plays-kenya',
    h1: 'Buy Spotify plays in Kenya',
    title: 'Buy Spotify Plays & Listeners in Kenya | smmpanel',
    description: 'Spotify plays, monthly listeners and followers from KSh 60. Pay with M-Pesa.',
    intro: 'Plays, listeners and playlist followers, priced per 1000 and paid with M-Pesa.',
    match: onPlatform(/spotify/i, /play|listener|follower/i),
    qtyLabel: 'plays',
    faq: [
      ['Which link do I paste?', 'The track or artist link from Spotify, not a screenshot or a search page.'],
    ],
  },
];

const BY_SLUG = new Map(LANDINGS.map((p) => [p.slug, p]));

function layout({ title, description, canonical, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(canonical)}" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${esc(config.siteName)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:image" content="${BASE}/og.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${BASE}/og.png" />
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
<link rel="stylesheet" href="/landing.css" />
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>`;
}

const pageLinks = () =>
  `<div class="grid-links">${LANDINGS.map(
    (p) => `<a href="/p/${p.slug}">${esc(p.h1.replace(/^Buy /, ''))}</a>`
  ).join('')}</div>`;

const header = () => `<header class="top">
  <a class="brand" href="/"><span>S</span>${esc(config.siteName)}</a>
  <a class="plain" href="/#/order?platform=all&sort=cheap">All prices</a>
</header>`;

const footer = () => `<footer class="foot">
  <p>${esc(config.siteName)} - pay with M-Pesa. Delivery depends on third-party vendors; delivered engagement can drop, see the terms.</p>
  <p><a href="/#/terms">Terms &amp; Conditions</a> · <a href="/#/privacy">Privacy</a> · <a href="/#/help">Help</a></p>
  ${pageLinks()}
</footer>`;

/** Cheapest matching services, with the KES retail price the order form will actually charge. */
async function pickServices(def, limit = 5) {
  const settings = await pricing.ensureSettings().catch(() => pricing.getSettings());
  let list = [];
  try {
    const c = await catalog.load();
    list = c.list.filter(def.match);
  } catch (err) {
    console.warn('[pages] catalog unavailable, rendering without prices:', err.message);
  }
  const priced = list
    .map((s) => ({ ...s, kesPer1000: pricing.sellRateKes(s.rate, settings) }))
    .filter((s) => Number.isFinite(s.kesPer1000) && s.kesPer1000 > 0)
    .sort((a, b) => a.kesPer1000 - b.kesPer1000);
  return priced.slice(0, limit);
}

router.get(
  '/p/:slug',
  wrap(async (req, res, next) => {
    const def = BY_SLUG.get(String(req.params.slug || '').toLowerCase());
    if (!def) return next();

    const services = await pickServices(def);
    const from = services.length ? Math.ceil(services[0].kesPer1000) : null;
    const canonical = `${BASE}/p/${def.slug}`;

    const rows = services
      .map(
        (s) => `<tr>
          <td>${esc(s.name.slice(0, 70))}</td>
          <td class="num">${kes(s.kesPer1000)}</td>
          <td class="num">${s.min ? s.min.toLocaleString('en-KE') : '-'}</td>
          <td class="num">${s.max ? s.max.toLocaleString('en-KE') : '-'}</td>
        </tr>`
      )
      .join('');

    const body = `${header()}
<h1>${esc(def.h1)}</h1>
<p class="lead">${esc(def.intro)}</p>
${from ? `<a class="btn" href="/#/order?service=${services[0].id}">Order now - from ${kes(from)}</a>` : ''}
<div class="card">
  <h2>Live prices${from ? ` · from ${kes(from)} per 1000` : ''}</h2>
  ${
    rows
      ? `<table><thead><tr><th>Service</th><th class="num">Per 1000</th><th class="num">Min</th><th class="num">Max</th></tr></thead><tbody>${rows}</tbody></table>
         <p class="hint">Prices include the service fee and follow the live provider rate. Quantities are measured in ${esc(def.qtyLabel)}.</p>`
      : '<p class="hint">Prices are refreshing right now - open the panel to see the full catalogue.</p>'
  }
</div>
<div class="card">
  <h2>How it works</h2>
  <ol class="steps">
    <li>Create an account with your email (no password sharing, ever).</li>
    <li>Add funds with M-Pesa - the STK prompt arrives on your phone.</li>
    <li>Paste the public link, choose the quantity and the order starts.</li>
  </ol>
</div>
<div class="card">
  <h2>Questions</h2>
  <dl class="faq">${def.faq
    .map(([q, a]) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`)
    .join('')}</dl>
</div>
<a class="btn" href="/#/register">Create an account</a>
<a class="btn ghost" href="/#/order?platform=all&amp;sort=cheap">Browse every price</a>
${footer()}`;

    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.type('html').send(layout({ title: def.title, description: def.description, canonical, body }));
  })
);

/** Dynamic sitemap: the app pages that matter, plus every landing page. */
router.get('/sitemap.xml', (_req, res) => {
  const now = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${BASE}/`, priority: '1.0' },
    ...LANDINGS.map((p) => ({ loc: `${BASE}/p/${p.slug}`, priority: '0.8' })),
    { loc: `${BASE}/#/order?platform=all&sort=cheap`, priority: '0.6' },
    { loc: `${BASE}/#/terms`, priority: '0.3' },
    { loc: `${BASE}/#/help`, priority: '0.4' },
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${now}</lastmod><priority>${u.priority}</priority></url>`)
  .join('\n')}
</urlset>`;
  res.type('application/xml').send(body);
});

module.exports = { router, LANDINGS };
