/* Web App bootstrap helper. Bundle/self-host this with the Next.js bootstrap page. */
(function (global) {
  'use strict';
  function send(value) {
    var raw = JSON.stringify(value);
    if (global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.MiraHandoffNative) {
      global.webkit.messageHandlers.MiraHandoffNative.postMessage(raw);
    } else if (global.MiraHandoffNative && global.MiraHandoffNative.postMessage) {
      global.MiraHandoffNative.postMessage(raw);
    } else { throw new Error('Native handoff bridge unavailable.'); }
  }
  var installed = false;
  global.MiraMobileBootstrap = {
    install: function (options) {
      if (installed) throw new Error('Bootstrap bridge already installed.');
      var attempt = options.attempt;
      if (!options.sessionReady && !/^[A-Za-z0-9_-]{1,256}$/.test(attempt || '')) throw new Error('Invalid attempt.');
      var redeem = new URL(options.redeemUrl, global.location.href);
      var target = new URL(options.successUrl, global.location.href);
      if (redeem.origin !== global.location.origin || target.origin !== global.location.origin ||
          redeem.username || redeem.password || target.username || target.password) throw new Error('Expected same-origin endpoints.');
      installed = true;
      var processing = false;
      var waitingForAck = false;
      var abort = new AbortController();
      function reportError() {
        send({ type: 'handoff.error', attempt: attempt });
        if (options.onError) options.onError('Unable to complete sign-in. Please retry from the mobile app.');
      }
      async function receive(event) {
        var data = event.detail;
        if (!data) return;
        if (data.type === 'handoff.accepted' && waitingForAck && (options.sessionReady || data.attempt === attempt)) {
          waitingForAck = false;
          global.removeEventListener('mira:native', receive);
          global.location.replace(target.href);
          return;
        }
        if (data.type !== 'auth.handoff' || data.attempt !== attempt || processing || options.sessionReady) return;
        if (typeof data.code !== 'string' || !data.code || data.code.length > 4096) return;
        processing = true;
        var timer = setTimeout(function () { abort.abort(); }, 20000);
        try {
          var response = await fetch(redeem.href, {
            method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal,
            headers: Object.assign({}, options.headers || {}, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ code: data.code })
          });
          // Contract: 200/204 only after actual NextAuth session cookie is established.
          if (response.status !== 200 && response.status !== 204) throw new Error('Redemption failed.');
          waitingForAck = true;
          send({ type: 'handoff.complete', attempt: attempt });
        } catch (_) { reportError(); }
        finally { clearTimeout(timer); }
      }
      global.addEventListener('mira:native', receive);
      if (options.sessionReady) {
        waitingForAck = true;
        send({ type: 'session.ready' });
      } else { send({ type: 'bootstrap.ready', attempt: attempt }); }
      return function cleanup() {
        abort.abort(); global.removeEventListener('mira:native', receive); installed = false;
      };
    }
  };
})(window);
