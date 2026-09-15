'use strict';

// Deliberately independent of cordova.plugins.OSInAppBrowser.
var exec = require('cordova/exec');
var active = null;
var serial = 0;
var SERVICE = 'MiraInAppBrowser';
function issue(code, message) { return { code: code, message: message }; }
function fail(cb, e) { if (typeof cb === 'function') cb(e); }
function attemptValid(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value); }
function codeValid(value) { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(value); }
function url(value, name) {
  var u;
  try { u = new URL(value); } catch (_) { throw issue('INVALID_OPTIONS', name + ' must be an absolute URL.'); }
  if (u.username || u.password || u.hash) throw issue('INVALID_OPTIONS', name + ' cannot contain credentials or a fragment.');
  return u;
}
function options(input) {
  var b = url(input.bootstrapUrl, 'bootstrapUrl');
  var a = url(input.authStartUrl, 'authStartUrl');
  var c = url(input.callbackUrl, 'callbackUrl');
  if (b.protocol !== 'https:' || a.origin !== b.origin || a.protocol !== 'https:')
    throw issue('INVALID_OPTIONS', 'Bootstrap and sign-in must use the same HTTPS origin.');
  if (a.searchParams.has('attempt') || a.searchParams.has('platform'))
    throw issue('INVALID_OPTIONS', 'The plugin adds attempt and platform to authStartUrl.');
  if (!/^[a-z][a-z0-9+.-]*:$/.test(c.protocol) || /^(https?|file|javascript|data|intent):$/.test(c.protocol) || !c.hostname || c.search)
    throw issue('INVALID_OPTIONS', 'v0.1 requires a configured custom-scheme app callback without query parameters.');
  var platform = input.platform;
  if (platform !== 'ios' && platform !== 'android') throw issue('INVALID_OPTIONS', 'platform must be ios or android.');
  var seconds = input.timeoutSeconds === undefined ? 600 : input.timeoutSeconds;
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 600) throw issue('INVALID_OPTIONS', 'timeoutSeconds must be 30–600.');
  return { bootstrapUrl: b.href, authStartUrl: a.href, callbackUrl: c.href, platform: platform, timeoutSeconds: seconds };
}
function emit(s, event) { if (active === s && typeof s.onEvent === 'function') s.onEvent(event); }
function terminal(s, error) {
  if (active !== s) return;
  active = null;
  clearTimeout(s.timer);
  // Native close is scoped to this service only; it never touches OSInAppBrowser.
  exec(function () {}, function () {}, SERVICE, 'close', []);
  fail(s.onError, error);
}
function stillPending(s) {
  if (!s || active !== s) throw issue('NO_PENDING_ATTEMPT', 'Start a new bootstrap attempt.');
  if (Date.now() >= s.deadline) throw issue('ATTEMPT_EXPIRED', 'Start a new bootstrap attempt.');
}
function receive(s, data, success, error) {
  try {
    stillPending(s);
    if (s.phase !== 'authenticating') throw issue('INVALID_STATE', 'No browser sign-in is awaiting a callback.');
    if (!data || !attemptValid(data.attempt) || data.attempt !== s.attempt || !codeValid(data.code))
      throw issue('INVALID_CALLBACK', 'Callback does not match the pending attempt.');
    s.phase = 'redeeming';
    exec(function () {
      if (active !== s) return;
      emit(s, { type: 'redeeming', attempt: s.attempt });
      if (success) success({ accepted: true });
    }, function () {
      var e = issue('DELIVERY_FAILED', 'Could not deliver to the original bootstrap page. Start again.');
      terminal(s, e); fail(error, e);
    }, SERVICE, 'deliverHandoff', [{ attempt: s.attempt, code: data.code }]);
  } catch (e) { fail(error, e); }
}
function callback(s, value, success, error) {
  try {
    stillPending(s);
    var received = url(value, 'callbackUrl');
    var expected = url(s.options.callbackUrl, 'callbackUrl');
    if (received.protocol !== expected.protocol || received.host !== expected.host || received.pathname !== expected.pathname ||
        received.searchParams.getAll('code').length !== 1 || received.searchParams.getAll('attempt').length !== 1 ||
        Array.from(received.searchParams.keys()).some(function (k) { return k !== 'code' && k !== 'attempt'; }))
      throw issue('INVALID_CALLBACK', 'Unexpected callback URL.');
    receive(s, { code: received.searchParams.get('code'), attempt: received.searchParams.get('attempt') }, success, error);
  } catch (e) { fail(error, e); }
}

module.exports = {
  open: function (input, onEvent, onError) {
    if (active) { fail(onError, issue('BUSY', 'Close the existing handoff browser first.')); return; }
    var config;
    try { config = options(input || {}); } catch (e) { fail(onError, e); return; }
    var s = { id: ++serial, options: config, phase: 'bootstrapping', attempt: null,
      deadline: Date.now() + config.timeoutSeconds * 1000, onEvent: onEvent, onError: onError };
    active = s;
    s.timer = setTimeout(function () { terminal(s, issue('ATTEMPT_EXPIRED', 'Sign-in timed out. Start again.')); }, config.timeoutSeconds * 1000);
    exec(function (event) {
      if (active !== s || !event) return;
      switch (event.type) {
      case 'opened': emit(s, { type: 'opened' }); break;
      case 'bootstrap.ready':
        if (s.phase !== 'bootstrapping' || !attemptValid(event.attempt)) return;
        s.attempt = event.attempt; s.phase = 'ready';
        emit(s, { type: 'ready', attempt: s.attempt }); break;
      case 'auth.callback':
        if (s.phase !== 'authenticating') return;
        callback(s, event.url, null, function (e) { terminal(s, e); }); break;
      case 'auth.cancelled':
        terminal(s, issue('AUTH_CANCELLED', 'Sign-in was cancelled.')); break;
      case 'handoff.complete':
        if (s.phase !== 'redeeming' || event.attempt !== s.attempt) return;
        s.phase = 'authenticated'; clearTimeout(s.timer);
        emit(s, { type: 'authenticated', attempt: s.attempt }); s.attempt = null; break;
      case 'session.ready':
        if (s.phase !== 'bootstrapping') return;
        s.phase = 'authenticated'; clearTimeout(s.timer);
        emit(s, { type: 'authenticated', reusedSession: true }); break;
      case 'handoff.error': terminal(s, issue('REDEMPTION_FAILED', 'The Web App could not establish a session. Start again.')); break;
      case 'closed':
        active = null; clearTimeout(s.timer);
        if (s.onEvent) s.onEvent({ type: 'closed' }); break;
      case 'navigation.blocked': emit(s, { type: 'navigationBlocked' }); break;
      case 'load.error': terminal(s, issue('PAGE_LOAD_FAILED', 'The Web App could not be loaded.')); break;
      }
    }, function (e) { terminal(s, issue(e && e.code || 'NATIVE_ERROR', 'The native handoff browser is unavailable or failed.')); }, SERVICE, 'open', [config]);
  },
  authenticate: function (success, error) {
    var s = active;
    try {
      stillPending(s);
      if (s.phase !== 'ready') throw issue('INVALID_STATE', 'Wait for bootstrap ready.');
      var target = new URL(s.options.authStartUrl);
      target.searchParams.set('attempt', s.attempt);
      target.searchParams.set('platform', s.options.platform);
      s.phase = 'authenticating';
      exec(function () { emit(s, { type: 'authStarted', attempt: s.attempt }); if (success) success(); },
        function () { var e = issue('BROWSER_FAILED', 'The authentication browser could not open.'); terminal(s, e); fail(error, e); },
        SERVICE, 'openAuth', [{ url: target.href }]);
    } catch (e) { fail(error, e); }
  },
  handleCallback: function (callbackUrl, success, error) { callback(active, callbackUrl, success, error); },
  // For the OutSystems HandoffCallback screen after its normal route handling.
  completeHandoff: function (data, success, error) { receive(active, data, success, error); },
  getState: function () { return active ? { phase: active.phase, attempt: active.attempt, expiresAt: active.deadline } : { phase: 'idle' }; },
  close: function (success, error) {
    var s = active; active = null;
    if (s) clearTimeout(s.timer);
    exec(function () { if (s && s.onEvent) s.onEvent({ type: 'closed' }); if (success) success(); }, error, SERVICE, 'close', []);
  }
};
