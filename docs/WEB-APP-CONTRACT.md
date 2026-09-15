# Web App bridge contract — version 1

This is the proposed contract implemented by plugin v0.1.0. Confirm or adapt the existing bootstrap page before integration. URLs below are examples; no environment endpoints are hardcoded in the plugin.

## Bootstrap

Serve a same-origin page such as `/auth/mobile/bootstrap`. It must be reachable without an established NextAuth session, create the pending attempt, and set an independent unpredictable binding secret in an HttpOnly, Secure cookie. The visible attempt ID is not the binding secret. Bind its hash server-side to the attempt. Suggested attempt expiry: 10 minutes or less.

Bundle `web/mira-handoff.js` in the bootstrap page (or implement the same protocol). After the attempt and binding cookie are established:

```javascript
window.MiraMobileBootstrap.install({
  attempt: response.attemptId,
  redeemUrl: '/api/auth/handoff/redeem',
  successUrl: '/overview',
  headers: { 'X-CSRF-Token': response.csrfToken }, // only if your backend requires this header
  onError: function (message) { /* show recoverable failure */ }
});
```

If the backend confirms a valid existing Web App session, install with `sessionReady: true` (and the same redeemUrl/successUrl options). Do not report sessionReady based only on a cookie's presence. The native browser can then continue directly without opening authentication.

The helper uses a restricted native channel. It does not depend on Cordova being installed in the remote page. Android injects `window.MiraHandoffNative`; iOS exposes `window.webkit.messageHandlers.MiraHandoffNative`. Only the configured HTTPS origin's main-frame bootstrap document is accepted. These interfaces support fixed handoff messages, not general native API calls.

## Sign-in

Native opens the configured authStartUrl and adds `attempt=<id>&platform=android|ios`. Store the selection server-side against the correlated browser authentication transaction. Use separate allowlisted platform callback values. Do not accept arbitrary client-supplied redirect destinations.

Preserve NextAuth/Entra state, nonce, PKCE and CSRF protections as applicable. Entra's callback remains the Web App HTTPS endpoint. After a validated login and access check, issue a random one-time code bound to the attempt, authenticated identity and independent WebView binding secret. Store only the code hash; suggested code expiry: 60 seconds.

Redirect to the configured custom-scheme app callback with exactly:

```text
<registered-app-scheme>://<actual-module>/HandoffCallback?code=<url-encoded-code>&attempt=<url-encoded-attempt>
```

No Entra tokens or Entra authorization code go to the app callback. v0.1's full URL parser accepts only `code` and `attempt`; cancellation/error redirect parameters require a separately agreed extension. On browser cancellation the user can close/retry or await the attempt timeout.

## Messages

| Direction | Payload | Meaning |
| --- | --- | --- |
| Web → native | `{ "type": "bootstrap.ready", "attempt": "att_123" }` | Cookie and attempt are ready |
| Native → Web | `{ "type": "auth.handoff", "attempt": "att_123", "code": "opaque" }` | Redeem once inside this document |
| Web → native | `{ "type": "handoff.complete", "attempt": "att_123" }` | Redemption succeeded and session cookie was set |
| Web → native | `{ "type": "handoff.error", "attempt": "att_123" }` | Redemption failed; restart |
| Web → native | `{ "type": "session.ready" }` | Server verified an existing session |
| Native → Web | `{ "type": "handoff.accepted", "attempt": "att_123" }` | Native received completion; page may navigate |

Native→Web messages arrive as a `mira:native` CustomEvent. The helper handles these and waits for the acknowledgement before navigating, preventing a navigation race with the completion message. Attempt IDs must match `[A-Za-z0-9_-]{1,256}`; opaque codes may be up to 4096 characters without whitespace/control characters.

## Redemption

The helper performs a same-origin POST with credentials, JSON body `{ "code": "..." }`, optional CSRF headers, no cache, and redirect rejection. It has a 20-second request timeout and never retries a possibly consumed code automatically.

Backend must validate Origin/CSRF, binding secret, code hash, expiry, expected user/attempt and permissions. Consume atomically. Establish a session compatible with the installed NextAuth version, adapter, callbacks and JWT/database strategy. Return **200 or 204 with Set-Cookie**, only after creating that session. The helper performs subsequent navigation itself; a 302 redirect from the redemption endpoint is not the helper's contract.

Session cookies must be HttpOnly/Secure and use appropriate Path/SameSite attributes. Keep the binding cookie until redemption completes, then clear it. Do not manually assume a hardcoded NextAuth cookie name or fabricate a session that protected APIs cannot validate.

Use no-store responses, restrict callback destinations, avoid third-party scripts on handoff/bootstrap pages, and suppress codes, tokens and cookie values in all application/proxy/analytics logs. Configure an appropriate Referrer-Policy for handoff pages. Agree on account mismatch, session expiry and logout semantics with the Mobile App team.
