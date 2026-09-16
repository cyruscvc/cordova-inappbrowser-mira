'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function harness(platform = 'android') {
  const calls = [], events = [], errors = [], timers = new Map();
  let nativeEvent, clock = 100000, timerId = 0;
  const sandbox = { module: { exports: {} }, URL, Date: { now: () => clock },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    require: name => {
      assert.equal(name, 'cordova/exec');
      return (ok, fail, service, action, args) => {
        assert.equal(service, 'MiraInAppBrowser'); calls.push({ action, args, ok, fail });
        if (action === 'open') nativeEvent = ok;
        else if (action !== 'deliverHandoff' && ok) ok();
      };
    } };
  vm.runInNewContext(fs.readFileSync('www/MiraInAppBrowser.js', 'utf8'), sandbox);
  const api = sandbox.module.exports;
  const options = { bootstrapUrl: 'https://web.example.test/auth/mobile/bootstrap', authStartUrl: 'https://web.example.test/azure-sso?mode=mobile',
    callbackUrl: 'com.example.mobile://Mobile/HandoffCallback', platform };
  return { api, calls, events, errors, timers, options,
    open(overrides = {}) { api.open({ ...options, ...overrides }, e => events.push(e), e => errors.push(e)); },
    event(e) { nativeEvent(e); }, advance(ms) { clock += ms; },
    ready() { nativeEvent({ type: 'bootstrap.ready', attempt: 'att_123' }); api.authenticate(null, e => errors.push(e)); },
    delivery() { return calls.findLast(c => c.action === 'deliverHandoff'); }
  };
}
test('retains one native open; browser URL carries platform and attempt; no code leaks into events', () => {
  const h = harness(); h.open(); h.ready();
  const auth = h.calls.find(c => c.action === 'openAuth');
  const u = new URL(auth.args[0].url);
  assert.equal(u.searchParams.get('attempt'), 'att_123');
  assert.equal(u.searchParams.get('platform'), 'android');
  assert.equal(u.searchParams.get('mode'), 'mobile');
  assert.equal(h.calls.filter(c => c.action === 'close').length, 0);
  h.api.completeHandoff({ attempt: 'att_123', code: 'secret_code' }, null, e => h.errors.push(e));
  h.delivery().ok(); h.event({ type: 'handoff.complete', attempt: 'att_123' });
  assert.equal(h.api.getState().phase, 'authenticated');
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.filter(c => c.action === 'open').length, 1);
  assert.equal(JSON.stringify(h.events).includes('secret_code'), false);
  assert.equal(h.errors.length, 0);
});
test('rejects mismatched, expired, unsolicited and duplicate callbacks before native delivery', () => {
  const h = harness(); const errors = [];
  h.api.completeHandoff({ attempt: 'att_123', code: 'x' }, null, e => errors.push(e));
  assert.equal(errors.pop().code, 'NO_PENDING_ATTEMPT');
  h.open(); h.ready();
  h.api.completeHandoff({ attempt: 'other', code: 'x' }, null, e => errors.push(e));
  assert.equal(errors.pop().code, 'INVALID_CALLBACK'); assert.equal(h.delivery(), undefined);
  h.api.completeHandoff({ attempt: 'att_123', code: 'x' }, null, e => errors.push(e));
  h.api.completeHandoff({ attempt: 'att_123', code: 'x' }, null, e => errors.push(e));
  assert.equal(errors.pop().code, 'INVALID_STATE');
  assert.equal(h.calls.filter(c => c.action === 'deliverHandoff').length, 1);
  const expired = harness(); expired.open(); expired.ready(); expired.advance(600001);
  expired.api.completeHandoff({ attempt: 'att_123', code: 'x' }, null, e => errors.push(e));
  assert.equal(errors.pop().code, 'ATTEMPT_EXPIRED'); assert.equal(expired.delivery(), undefined);
});
test('strict callback URL rejects wrong routes, duplicate keys, fragments and arbitrary fields', () => {
  const h = harness('ios'); h.open(); h.ready(); const errors = [];
  for (const bad of [
    'com.other://Mobile/HandoffCallback?code=x&attempt=att_123',
    'com.example.mobile://Mobile/Other?code=x&attempt=att_123',
    'com.example.mobile://Mobile/HandoffCallback?code=x&code=y&attempt=att_123',
    'com.example.mobile://Mobile/HandoffCallback?code=x&attempt=att_123#fragment',
    'com.example.mobile://Mobile/HandoffCallback?code=x&attempt=att_123&redirect=https://evil.test'
  ]) h.api.handleCallback(bad, null, e => errors.push(e));
  assert.equal(errors.length, 5); assert.equal(h.delivery(), undefined);
  h.event({ type: 'auth.callback', url: 'com.example.mobile://Mobile/HandoffCallback?code=valid&attempt=att_123' });
  assert.equal(h.delivery().args[0].code, 'valid');
  h.event({ type: 'auth.callback', url: 'com.example.mobile://Mobile/HandoffCallback?code=valid&attempt=att_123' });
  assert.equal(h.errors.length, 0); // duplicated OS callback cannot abort successful redemption
});
test('rejects cross-origin and non-HTTPS entry URLs and second simultaneous browser', () => {
  for (const overrides of [{ bootstrapUrl: 'http://web.example.test/bootstrap' }, { authStartUrl: 'https://evil.test/login' },
    { authStartUrl: 'https://web.example.test/login?attempt=att_bad' }, { callbackUrl: 'https://app.example.test/callback' }]) {
    const h = harness(); h.open(overrides); assert.equal(h.errors.length, 1); assert.equal(h.calls.length, 0);
  }
  const h = harness(); h.open(); h.open(); assert.equal(h.errors[0].code, 'BUSY');
  assert.equal(h.calls.filter(c => c.action === 'open').length, 1);
});
test('lost document fails closed; successful native dispatch alone is not authentication', () => {
  const h = harness(); h.open(); h.ready();
  h.api.completeHandoff({ attempt: 'att_123', code: 'x' }, null, () => {});
  h.delivery().ok(); assert.equal(h.api.getState().phase, 'redeeming');
  h.event({ type: 'handoff.complete', attempt: 'other' }); assert.equal(h.api.getState().phase, 'redeeming');
  h.delivery().fail({}); assert.equal(h.api.getState().phase, 'idle');
  assert.equal(h.errors[0].code, 'DELIVERY_FAILED');
});
test('browser cancellation and stale callbacks cannot affect a later attempt', () => {
  const h = harness(); h.open(); h.ready(); const old = h.calls.find(c => c.action === 'open').ok;
  h.event({ type: 'auth.cancelled' }); assert.equal(h.api.getState().phase, 'idle');
  h.open(); old({ type: 'load.error' }); assert.equal(h.api.getState().phase, 'bootstrapping');
  assert.equal(h.errors.length, 1);
});
test('already-authenticated bootstrap bypasses browser; malformed ready is ignored', () => {
  const h = harness(); h.open(); h.event({ type: 'bootstrap.ready', attempt: '../bad' });
  assert.equal(h.api.getState().phase, 'bootstrapping');
  h.event({ type: 'session.ready' }); assert.equal(h.api.getState().phase, 'authenticated');
  assert.equal(h.calls.filter(c => c.action === 'openAuth').length, 0);
});
test('navigation allowlist defaults to empty and normalizes only exact HTTPS origins', () => {
  const h = harness(); h.open();
  assert.equal(h.calls[0].args[0].allowedNavigationOrigins.length, 0);
  const extra = harness(); extra.open({ allowedNavigationOrigins: ['https://access.example.test:443/', 'https://access.example.test'] });
  assert.deepEqual(Array.from(extra.calls[0].args[0].allowedNavigationOrigins), ['https://access.example.test']);
  for (const value of [null, 'https://access.example.test', ['http://access.example.test'], ['https://*.example.test'],
    ['https://access.example.test/path'], ['https://access.example.test/?code=secret'], ['https://access.example.test/#secret'],
    ['https://user:secret@access.example.test'], Array(9).fill('https://access.example.test')]) {
    const invalid = harness(); invalid.open({ allowedNavigationOrigins: value });
    assert.equal(invalid.errors[0].code, 'INVALID_OPTIONS'); assert.equal(invalid.calls.length, 0);
  }
});
test('navigation permission does not allow a cross-origin authentication entry point', () => {
  const h = harness();
  h.open({ allowedNavigationOrigins: ['https://access.example.test'], authStartUrl: 'https://access.example.test/login' });
  assert.equal(h.errors[0].code, 'INVALID_OPTIONS'); assert.equal(h.calls.length, 0);
});
test('blocked navigation records origin only and preserves the pending attempt', () => {
  const h = harness(); h.open();
  h.event({ type: 'navigation.blocked', origin: 'https://access.example.test/path?code=secret#fragment', url: 'secret' });
  assert.equal(h.api.getState().phase, 'bootstrapping');
  assert.equal(h.api.getState().lastBlockedOrigin, 'https://access.example.test');
  assert.equal(JSON.stringify(h.events).includes('secret'), false);
  h.event({ type: 'navigation.blocked', origin: 'javascript:secret' });
  assert.equal(h.api.getState().lastBlockedOrigin, null);
});
test('terminal load errors survive idle with safe native metadata and clear on a new attempt', () => {
  const h = harness('ios'); h.open();
  h.event({ type: 'navigation.blocked', origin: 'https://access.example.test' });
  h.event({ type: 'load.error', nativeErrorDomain: 'NSURLErrorDomain', nativeErrorCode: -1200,
    url: 'https://web.example.test/?code=secret', localizedDescription: 'secret', userInfo: { code: 'secret' } });
  const state = h.api.getState();
  assert.equal(state.phase, 'idle'); assert.equal(state.lastError.code, 'PAGE_LOAD_FAILED');
  assert.equal(state.lastError.nativeErrorCode, -1200); assert.equal(state.lastError.nativeErrorDomain, 'NSURLErrorDomain');
  assert.equal(state.lastBlockedOrigin, 'https://access.example.test');
  assert.equal(JSON.stringify(state).includes('secret'), false);
  assert.equal(JSON.stringify(h.errors).includes('secret'), false);
  state.lastError.nativeErrorCode = 123;
  assert.equal(h.api.getState().lastError.nativeErrorCode, -1200);
  h.open(); assert.equal(h.api.getState().lastError, undefined); assert.equal(h.api.getState().lastBlockedOrigin, undefined);
});
test('load diagnostics discard invalid metadata and preserve HTTP status', () => {
  const h = harness(); h.open();
  h.event({ type: 'load.error', nativeErrorDomain: 'https://bad.test/?token=secret', nativeErrorCode: 'secret', httpStatus: 403 });
  assert.equal(h.api.getState().lastError.httpStatus, 403);
  assert.equal(h.api.getState().lastError.nativeErrorDomain, undefined);
  assert.equal(h.api.getState().lastError.nativeErrorCode, undefined);
});
