// Unit tests for the paste-a-link recommendation engine. No server, no database: the module is a
// pure function over the cached catalog, so these run instantly.
const assert = require('assert');
const { recommend, detectPlatform, inferGoal } = require('../src/recommend');

let pass = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

// A settings object shaped exactly like pricing.getSettings()
const settings = { markup: 1.2, kesPerUsd: 129, feeKes: 0, feeCents: 0 };

// A small, hand-built catalog: two Instagram services, a flat package, one that takes no link,
// and a TikTok service so "wrong platform" is observable.
const catalog = [
  { id: 1, name: 'Instagram Followers - cheap, no refill', category: 'Instagram Followers', type: 'Default', rate: '0.30', min: 100, max: 100000, refill: false, cancel: false, speed: '1-2 days' },
  { id: 2, name: 'Instagram Followers - with refill', category: 'Instagram Followers', type: 'Default', rate: '0.34', min: 50, max: 50000, refill: true, cancel: true, speed: '0-1h' },
  { id: 3, name: 'Instagram Followers - premium', category: 'Instagram Followers [PREMIUM]', type: 'Default', rate: '1.90', min: 10, max: 10000, refill: true, cancel: true, speed: 'instant' },
  { id: 4, name: 'Instagram Package 500', category: 'Instagram Followers', type: 'Package', rate: '2.00', min: 1, max: 1, refill: false, cancel: false, speed: '0-1h' },
  { id: 5, name: 'Instagram Web Traffic', category: 'Instagram Traffic', type: 'Web Traffic', rate: '0.20', min: 1000, max: 1000, refill: false, cancel: false, speed: '1-2 days' },
  { id: 6, name: 'TikTok Followers', category: 'TikTok Followers', type: 'Default', rate: '0.25', min: 100, max: 90000, refill: true, cancel: false, speed: '0-1h' },
];

console.log('recommend engine tests');

test('detects the platform from a full URL', () => {
  assert.equal(detectPlatform('https://www.instagram.com/p/Cxyz123/?igsh=1'), 'instagram');
  assert.equal(detectPlatform('https://vm.tiktok.com/ZMabc/'), 'tiktok');
  assert.equal(detectPlatform('https://youtu.be/dQw4w9WgXcQ'), 'youtube');
  assert.equal(detectPlatform('https://x.com/someone/status/1'), 'twitter');
  assert.equal(detectPlatform('https://t.me/achannel'), 'telegram');
  assert.equal(detectPlatform('https://chat.whatsapp.com/ABC123'), 'whatsapp');
  assert.equal(detectPlatform('https://open.spotify.com/track/xyz'), 'spotify');
});

test('detects the platform from a bare host or a loose word', () => {
  assert.equal(detectPlatform('instagram.com/p/abc'), 'instagram');
  assert.equal(detectPlatform('m.facebook.com/page'), 'facebook');
  assert.equal(detectPlatform('my tiktok account'), 'tiktok');
  assert.equal(detectPlatform('instagram @someone'), 'instagram');
});

test('returns null instead of guessing at an unknown link', () => {
  assert.equal(detectPlatform('https://example.co.ke/blog/post'), null);
  assert.equal(detectPlatform(''), null);
  assert.equal(detectPlatform('   '), null);
});

test('the best pick is a cheap per-1000 service that takes a link', () => {
  const out = recommend('https://instagram.com/someone', catalog, settings);
  assert.equal(out.detected, 'instagram');
  assert.ok(out.services.length >= 1);
  const best = out.services[0];
  // #1 is the cheapest, but #2 is six cents dearer with refill + instant start, so it wins on score
  assert.equal(best.id, 2, `expected the refill service to win, got ${best.id}`);
  assert.ok(best.refill);
  assert.ok(best.reasons.some((r) => /refill/i.test(r)), best.reasons.join(', '));
});

test('a service that cannot take a link is never recommended', () => {
  const out = recommend('https://instagram.com/someone', catalog, settings);
  assert.ok(!out.services.some((s) => s.id === 5), 'Web Traffic takes no link and must be excluded');
});

test('a service on another platform never leaks into the answer', () => {
  const out = recommend('https://instagram.com/someone', catalog, settings);
  assert.ok(!out.services.some((s) => s.id === 6), 'TikTok service must not be offered for an Instagram link');
});

test('prices are customer-facing KES cents and no provider rate is exposed', () => {
  const out = recommend('https://instagram.com/someone', catalog, settings);
  for (const s of out.services) {
    assert.equal(typeof s.per1000_cents, 'number');
    assert.ok(s.per1000_cents > 0);
    assert.ok(!('rate' in s), 'provider rate must not be on the wire');
    assert.ok(!('rate_cents_usd' in s));
  }
  const json = JSON.stringify(out);
  assert.ok(!/0\.34|\b0\.30\b/.test(json), 'raw provider rates must not appear anywhere in the payload');
});

test('the link itself is never echoed back', () => {
  const link = 'https://instagram.com/private-person';
  const out = recommend(link, catalog, settings);
  assert.ok(!JSON.stringify(out).includes('private-person'), 'the pasted link must not come back in the payload');
  assert.equal(out.host, 'instagram.com');
});

test('a quantity below the minimum is penalised', () => {
  const small = recommend('https://instagram.com/x', catalog, settings, { quantity: 40 });
  // #2 has min 50, #4 (package) has min 1: with a 50-ish quantity the cheaper per-1000 still wins,
  // but a service whose minimum cannot be met must rank below the ones that can.
  const firstOutOfRange = small.services.findIndex((s) => s.min > 40);
  const firstInRange = small.services.findIndex((s) => s.min <= 40);
  if (firstOutOfRange >= 0 && firstInRange >= 0) assert.ok(firstInRange < firstOutOfRange);
});

test('the goal is inferred from the shape of the link', () => {
  assert.equal(inferGoal('https://instagram.com/someone'), 'followers');
  assert.equal(inferGoal('https://instagram.com/p/Cxyz/'), 'views');
  assert.equal(inferGoal('https://t.me/achannel'), 'followers');
  assert.equal(inferGoal('https://youtu.be/abc'), 'views');
  assert.equal(inferGoal('https://x.com/someone/status/1'), 'views');
});

test('an explicit goal narrows the answer to that kind of service', () => {
  const out = recommend('https://instagram.com/someone', catalog, settings, { goal: 'followers' });
  assert.equal(out.goal, 'followers');
  assert.equal(out.goal_inferred, false);
  assert.ok(out.services.every((s) => /follower/i.test(`${s.name} ${s.category}`)), out.services.map((s) => s.name).join(', '));
});

test('a profile link defaults to followers without being told', () => {
  const out = recommend('https://instagram.com/someone', catalog, settings, {});
  assert.equal(out.goal, 'followers');
  assert.equal(out.goal_inferred, true);
});

test('a goal the catalogue cannot serve falls back to everything', () => {
  const noComments = catalog.map((s) => ({ ...s, name: s.name.replace(/comment/gi, ''), category: s.category.replace(/comment/gi, ''), type: 'Default' }));
  const out = recommend('https://instagram.com/someone', noComments, settings, { goal: 'comments' });
  assert.ok(out.services.length > 0, 'must still answer with something orderable');
  assert.equal(out.goal, null);
});

test('"cheapest first" really is ordered by price', () => {
  const out = recommend('https://instagram.com/someone', catalog, settings, { sort: 'price' });
  const prices = out.services.map((s) => s.per1000_cents);
  for (let i = 1; i < prices.length; i++) assert.ok(prices[i] >= prices[i - 1], `not ascending: ${prices.join(', ')}`);
  assert.equal(out.sort, 'price');
});

test('an unknown link returns alternatives instead of an error', () => {
  const out = recommend('https://example.co.ke/post', catalog, settings);
  assert.equal(out.detected, null);
  assert.equal(out.services.length, 0);
  assert.ok(out.alternatives.length > 0, 'the customer must get something to tap');
  assert.match(out.note, /could not tell/i);
});

test('every result carries an order link id and the platform key', () => {
  const out = recommend('https://instagram.com/x', catalog, settings);
  assert.equal(out.platform.key, 'instagram');
  assert.ok(out.services.every((s) => Number.isInteger(s.id) && s.id > 0));
});

console.log(`\n${pass}/${pass + failures.length} passed`);
if (failures.length) process.exit(1);
