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
  return { window, sent, requests, navigations,
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
