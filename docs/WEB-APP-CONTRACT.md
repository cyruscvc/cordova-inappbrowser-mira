# Web App bridge contract — version 1

This contract is implemented by plugin v0.1.0 and later. Version 0.1.2 adds an opt-in chatbot-first mode without changing native message names. Confirm or adapt the existing page before integration. URLs below are examples; no environment endpoints are hardcoded in the plugin.

## Button-triggered chatbot integration (0.1.2)

The mobile team opens MIRA with this plugin using `initialUrl: 'https://mira.stg.mubadala.ae/azure-sso'` (added in 0.1.3), the chatbot's exact URL as `bootstrapUrl`, and `authenticationMode: 'onDemand'`. The initial WebView SSO redirects must reach the chatbot before its upload button requests the handoff. The native handler is installed before loading the initial page; message acceptance and code delivery still require the configured chatbot origin/path. Standard OutSystems `OpenInWebView` does not provide this plugin's `MiraHandoffNative` handler.

Load the helper on the chatbot but do not call `install` on mount. Before creating an attempt on a button tap, check `window.MiraMobileBootstrap.isAvailable()`. If false, show a recoverable message and do not create an attempt or poll indefinitely. This method checks the named callable interface; it does not prove native acknowledgement, resource authorization, or identify a WebView from its user agent.

On the upload/OneDrive button:

1. Use a single in-flight guard and disable repeated sign-in taps.
2. Call the existing same-origin attempt-creation API. It must establish the independent HttpOnly binding cookie in this WebView, even if the chatbot already has its own login session. Create attempts at tap time, not page mount.
3. Call `MiraMobileBootstrap.install` with the returned attempt ID and `signInUrl`, `/api/auth/outsystems-handoff/redeem`, and `/maia-personal-assistant?onedrive=1` as the success URL. Keep required CSRF headers. Leave `sessionReady` false for a new authentication request.
4. Keep this document mounted until completion. Store and call the returned cleanup function when the component/document is intentionally torn down. Unmounting during a handoff requires restarting, not reusing the old attempt.
5. After redemption and native acknowledgement, the helper navigates to the success URL. That destination must consume `onedrive=1`, verify Microsoft file access and resume the OneDrive component without starting a login loop. Persist unsent chat state using the application's existing state mechanism before starting the flow; this helper's success navigation reloads the document.

Helper loading alone neither registers a native handler nor starts authentication. `install` still sends `bootstrap.ready`; it now means the button has prepared an attempt. The controller starts its deadline on that message and the app wrapper responds to `ready` with `authenticate`.

The helper exposes `isAvailable()` and cleans up if its first native message throws, allowing a later installation after the bridge is available. A completed, cancelled, expired or failed native handoff still requires closing/reopening for another authentication cycle; this version does not reset native one-time delivery protection.

**Sign-in URL:** pass `signInUrl: response.signInUrl` into `install` to preserve the server-generated continuation parameters. The controller requires the exact configured `AuthStartUrl` origin/path, one matching attempt, a matching platform if supplied, and unchanged configured query parameters. Credentials and fragments are rejected. It adds `platform` when omitted. If `signInUrl` is absent, it constructs the URL from `AuthStartUrl` as before. The full URL is internal and never included in public events or diagnostics. The server must still allowlist the continuation destination; do not use arbitrary redirects.

After the attempt-creation API succeeds, the relevant helper call is:

```javascript
const cleanup = window.MiraMobileBootstrap.install({
  attempt: response.attemptId,
  signInUrl: response.signInUrl,
  redeemUrl: '/api/auth/outsystems-handoff/redeem',
  successUrl: '/maia-personal-assistant?onedrive=1',
  sessionReady: false,
  onError: message => { /* display the error and offer to reopen from M App */ }
});
```

Check `isAvailable()` and set the in-flight guard before calling the attempt API. Retain `cleanup` for component teardown. Add the backend's required CSRF headers to this call as appropriate.

The cookie-binding, code redemption and Microsoft authorization requirements below apply unchanged on the chatbot route.

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

From 0.1.2, `bootstrap.ready` may include the validated API-returned `signInUrl`; the controller uses its correlated continuation parameters as described above. Both native implementations forward this one optional field internally. Keep ready-message JSON within 8192 bytes (including the maximum 4096-character URL). Never include credentials or Microsoft tokens in the URL.

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
