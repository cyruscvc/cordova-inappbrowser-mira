'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function setup(status = 204) {
  const listeners = new Map(), sent = [], requests = [], navigations = [];
  const window = {
    location: { href: 'https://web.example.test/auth/mobile/bootstrap', origin: 'https://web.example.test', replace: value => navigations.push(value) },
    MiraHandoffNative: { postMessage: raw => sent.push(JSON.parse(raw)) },
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name)
  };
  const sandbox = { window, URL, AbortController, setTimeout: () => 1, clearTimeout: () => {},
    fetch: async (url, opts) => { requests.push({ url, opts }); return { status }; } };
  vm.runInNewContext(fs.readFileSync('web/mira-handoff.js', 'utf8'), sandbox);
  return { window, sent, requests, navigations, listeners, sandbox,
    install(overrides = {}) { return window.MiraMobileBootstrap.install({ attempt: 'att_123', redeemUrl: '/api/auth/handoff/redeem', successUrl: '/overview', ...overrides }); },
    receive(data) { return listeners.get('mira:native')({ detail: data }); }
  };
}
test('redemption uses same-origin cookie context and only navigates after native acknowledgement', async () => {
  const h = setup(); h.install();
  assert.equal(h.sent[0].type, 'bootstrap.ready');
  await h.receive({ type: 'auth.handoff', attempt: 'att_123', code: 'opaque' });
  assert.equal(h.requests.length, 1);
  const req = h.requests[0];
  assert.equal(req.opts.credentials, 'same-origin'); assert.equal(req.opts.redirect, 'error');
  assert.equal(req.opts.cache, 'no-store'); assert.equal(req.opts.method, 'POST');
  assert.deepEqual(JSON.parse(req.opts.body), { code: 'opaque' });
  assert.equal(h.navigations.length, 0);
  assert.equal(h.sent[1].type, 'handoff.complete');
  await h.receive({ type: 'handoff.accepted', attempt: 'att_123' });
  assert.equal(h.navigations[0], 'https://web.example.test/overview');
});
test('mismatched attempt and repeated delivery cannot cause extra redemption', async () => {
  const h = setup(); h.install();
  await h.receive({ type: 'auth.handoff', attempt: 'wrong', code: 'opaque' });
  assert.equal(h.requests.length, 0);
  await h.receive({ type: 'auth.handoff', attempt: 'att_123', code: 'opaque' });
  await h.receive({ type: 'auth.handoff', attempt: 'att_123', code: 'opaque' });
  assert.equal(h.requests.length, 1);
});
test('failed redemption does not navigate or claim authentication', async () => {
  const h = setup(401); h.install();
  await h.receive({ type: 'auth.handoff', attempt: 'att_123', code: 'opaque' });
  assert.equal(h.sent.at(-1).type, 'handoff.error'); assert.equal(h.navigations.length, 0);
  assert.equal(h.sent.some(e => e.type === 'handoff.complete'), false);
});
test('bootstrap helper rejects cross-origin endpoints and destinations', () => {
  assert.throws(() => setup().install({ redeemUrl: 'https://other.example.test/redeem' }));
  assert.throws(() => setup().install({ successUrl: 'https://other.example.test/overview' }));
});
test('server-verified existing session navigates without a redemption request', async () => {
  const h = setup(); h.install({ sessionReady: true });
  assert.equal(h.sent[0].type, 'session.ready');
  await h.receive({ type: 'handoff.accepted' });
  assert.equal(h.navigations.length, 1); assert.equal(h.requests.length, 0);
});

test('loading the helper never starts login; bridge check works for Android and iOS', () => {
  const h = setup();
  assert.equal(h.window.MiraMobileBootstrap.isAvailable(), true);
  assert.equal(h.sent.length, 0);
  delete h.window.MiraHandoffNative;
  assert.equal(h.window.MiraMobileBootstrap.isAvailable(), false);
  assert.throws(() => h.install(), /Native handoff bridge unavailable/);
  assert.equal(h.listeners.size, 0);
  h.window.webkit = { messageHandlers: { MiraHandoffNative: { postMessage: raw => h.sent.push(JSON.parse(raw)) } } };
  assert.equal(h.window.MiraMobileBootstrap.isAvailable(), true);
  h.install(); assert.equal(h.sent[0].type, 'bootstrap.ready');
});
test('first-message failure releases helper state so the user can retry', () => {
  const h = setup();
  h.window.MiraHandoffNative.postMessage = () => { throw new Error('bridge disconnected'); };
  assert.throws(() => h.install(), /bridge disconnected/);
  assert.equal(h.listeners.size, 0);
  h.window.MiraHandoffNative.postMessage = raw => h.sent.push(JSON.parse(raw));
  h.install(); assert.equal(h.sent.length, 1);
  assert.throws(() => h.install(), /already installed/);
});
test('cleanup from an old chat component cannot release a newer installation', () => {
  const h = setup(); const old = h.install(); old();
  h.install({ attempt: 'att_new' }); old();
  assert.throws(() => h.install(), /already installed/);
  assert.equal(h.listeners.size, 1);
});
test('unmounting during redemption suppresses stale completion or error messages', async () => {
  for (const reject of [false, true]) {
    const h = setup(); let finish;
    h.sandbox.fetch = () => new Promise((resolve, fail) => { finish = reject ? () => fail(new Error('aborted')) : () => resolve({ status: 204 }); });
    const cleanup = h.install();
    const pending = h.receive({ type: 'auth.handoff', attempt: 'att_123', code: 'opaque' });
    cleanup(); finish(); await pending;
    assert.equal(h.sent.length, 1); assert.equal(h.listeners.size, 0); assert.equal(h.navigations.length, 0);
  }
});

test('helper forwards the correlated sign-in URL and rejects unsafe URLs before posting', () => {
  const h = setup();
  h.install({ signInUrl: '/azure-sso?attempt=att_123&callbackUrl=%2Fauth%2Foutsystems%2Fhandoff%3Fattempt%3Datt_123' });
  const target = new URL(h.sent[0].signInUrl);
  assert.equal(target.origin, h.window.location.origin);
  assert.equal(target.searchParams.get('callbackUrl'), '/auth/outsystems/handoff?attempt=att_123');
  for (const signInUrl of ['https://evil.test/login?attempt=att_123', '/login?attempt=wrong',
    '/login?attempt=att_123&attempt=att_123', '/login?attempt=att_123#secret', 'https://user:secret@web.example.test/login?attempt=att_123']) {
    const bad = setup(); assert.throws(() => bad.install({ signInUrl }), /Invalid sign-in URL/);
    assert.equal(bad.sent.length, 0); assert.equal(bad.listeners.size, 0);
  }
});
