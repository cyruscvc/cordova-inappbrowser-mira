# OutSystems 11 setup

Use a separate wrapper module, suggested name `InAppBrowser_Mira_Plugin`. Preserve the existing InAppBrowser wrapper and its consumers.

## Install from GitHub

Use this Extensibility Configuration in the separate wrapper module:

```json
{
  "plugin": {
    "url": "https://github.com/cyruscvc/cordova-inappbrowser-mira.git#main"
  }
}
```

For a reproducible MABS build, replace `main` with the full commit SHA being tested. Select either the GitHub configuration or the local Resource configuration below. Do not install this plugin twice through both methods. The original InAppBrowser plugin can remain installed alongside it.

Publish the wrapper, refresh the dependency in the Mobile App, and generate/install new native builds.

## Install from a local Resource

1. Add `inappbrowser-mira.zip` to the wrapper Resources.
2. Set Deploy Action to `Do Nothing`, Public to `No`, and leave Target Directory blank.
3. Use this Extensibility Configuration:

```json
{
  "resource": "inappbrowser-mira.zip",
  "plugin": { "resource": "inappbrowser-mira" }
}
```

4. Expose the client actions below. Publish the wrapper and refresh its dependency in the Mobile App.
5. Generate new Android and iOS packages through MABS and install them. An existing binary cannot gain this plugin by publishing screens alone.

## OpenHandoffBrowser

Inputs: `BootstrapUrl`, `AuthStartUrl`, `CallbackUrl` (Text). Outputs: `IsSuccess` (Boolean), `ErrorMessage` (Text).

The callback URL must be the exact route handled by the relevant installed build. Pass the platform-specific value from trusted application configuration. The earlier illustrative module/screen placeholders are not working URLs.

Put this in an asynchronous JavaScript node. The node resolves when the native browser is opened. Authentication continues in the Cordova module even if the originating screen is later destroyed.

```javascript
var p = window.cordova && cordova.plugins && cordova.plugins.MiraInAppBrowser;
if (!p) {
  $parameters.IsSuccess = false;
  $parameters.ErrorMessage = 'Install the new native test build.';
  $resolve();
  return;
}
var settled = false;
function settle(ok, message) {
  if (settled) return;
  settled = true;
  $parameters.IsSuccess = ok;
  $parameters.ErrorMessage = message || '';
  $resolve();
}
// Safe status only. Do not put the handoff code or full callback URL here.
window.miraHandoffStatus = { phase: 'opening' };
p.open({
  bootstrapUrl: $parameters.BootstrapUrl,
  authStartUrl: $parameters.AuthStartUrl,
  callbackUrl: $parameters.CallbackUrl,
  platform: cordova.platformId,
  timeoutSeconds: 600,
  allowedNavigationOrigins: [] // Add only exact HTTPS origins required by your access gateway
}, function (event) {
  window.miraHandoffStatus = event;
  if (event.type === 'opened') settle(true, '');
  if (event.type === 'ready') {
    p.authenticate(function () {}, function (error) {
      window.miraHandoffStatus = { phase: 'error', message: error.message };
    });
  }
}, function (error) {
  window.miraHandoffStatus = { phase: 'error', message: error.message };
  settle(false, error.message);
});
```

Post-open errors do not reject the already-resolved action. Read `GetHandoffState` / `window.miraHandoffStatus` on the underlying screen's return and display Retry/Close as appropriate. Do not retain `$actions` references to a destroyed screen in a persistent callback.

Version 0.1.1 adds `allowedNavigationOrigins` to the `open` options. For example, use `['https://access.example.test']` after replacing that example with the actual approved gateway origin. Do not change BootstrapUrl to a temporary gateway URL. Navigation permission does not grant access to the handoff bridge. Regenerate and install native builds after changing the plugin version; changing this JavaScript alone cannot update the native navigation policy.

## OpenChatBrowser: button-triggered login (0.1.2)

Duplicate `OpenHandoffBrowser` as `OpenChatBrowser` and keep its asynchronous node, outputs, event handler and error handling. Add a Text input named `ChatUrl` in place of `BootstrapUrl`. In `p.open`, replace the bootstrap option and add the mode:

```javascript
bootstrapUrl: $parameters.ChatUrl,
authenticationMode: 'onDemand',
```

Keep `authStartUrl`, `callbackUrl`, `platform`, `timeoutSeconds`, `allowedNavigationOrigins`, and the `ready → p.authenticate` handler from the full node above. `ready` is emitted only after the chatbot button posts a valid attempt; `opened` must not call `authenticate`.

Use these inputs for the staging integration:

| Input | Value |
| --- | --- |
| ChatUrl | `https://mira.stg.mubadala.ae/maia-personal-assistant` |
| AuthStartUrl | `https://mira.stg.mubadala.ae/azure-sso` (confirm the sign-in contract below) |
| CallbackUrl | Existing verified platform-specific M App callback route |

Replace the M App action that currently opens this chatbot through standard `OpenInWebView` with `OpenChatBrowser`. Do not open the standard browser first or try to attach this plugin to it. This plugin creates and owns its own WebView.

The native handlers already use the configured `bootstrapUrl` path. The chatbot must remain on that exact origin/path while requesting authentication and receiving the code. Query parameters such as `?onedrive=1` are allowed. Gateway origins, if configured, permit navigation only; they never receive bridge permission. A changed pathname or full-page reload during the pending attempt requires restarting the flow.

The controller waits in `browsing` without a login timeout until the page posts `bootstrap.ready`. After that, normal expiry, callback validation and redemption checks apply. Only one handoff per opened browser is supported; close/reopen for another authentication attempt. Do not call helper `install({sessionReady:true})` merely because the chatbot itself has a session: it finishes this browser's handoff cycle and does not prove Microsoft file access is available.

**Sign-in URL contract:** the web team can now pass its API-returned `signInUrl` into helper `install`. This preserves their correlated `callbackUrl=/auth/outsystems/handoff?attempt=...` parameter. The plugin requires the exact HTTPS origin/path from `AuthStartUrl`, a single matching attempt, a matching platform if supplied, and all query parameters fixed in `AuthStartUrl` unchanged. It adds `platform` if absent. Without `signInUrl`, the original configured-URL behavior remains. The full URL is never included in public plugin events or diagnostics. Server-side callback allowlists and normal OAuth protections still apply.

Update the wrapper's Git reference to the tested change commit, publish/refresh dependencies and generate/install new MABS packages. Have the web team deploy the updated helper as their `/mira-mobile-bootstrap.js` if that is the existing served filename. The repository helper is `web/mira-handoff.js`.

This plugin remains a dedicated handoff browser: the standard plugin's file upload/download support is not inherited. Test the OneDrive web integration separately after login, including its Microsoft token acquisition and tenant policy. If the chatbot requires general native file selection or downloads, that feature requires a separate implementation in this browser.

## CompleteHandoff (callback action)

Inputs: `Code`, `Attempt` (Text). Outputs: `IsSuccess` (Boolean), `ErrorMessage` (Text).

```javascript
var p = window.cordova && cordova.plugins && cordova.plugins.MiraInAppBrowser;
if (!p) {
  $parameters.IsSuccess = false;
  $parameters.ErrorMessage = 'Install the new native test build.';
  $resolve();
  return;
}
// iOS ASWebAuthenticationSession may already have consumed the callback.
var state = p.getState();
if (state.phase === 'authenticated' ||
    (state.phase === 'redeeming' && state.attempt === $parameters.Attempt)) {
  $parameters.IsSuccess = true;
  $parameters.ErrorMessage = '';
  $resolve();
  return;
}
p.completeHandoff({ code: $parameters.Code, attempt: $parameters.Attempt }, function () {
  $parameters.IsSuccess = true;
  $parameters.ErrorMessage = '';
  $resolve();
}, function (error) {
  $parameters.IsSuccess = false;
  $parameters.ErrorMessage = error.message;
  $resolve();
});
```

IsSuccess means accepted/delivered, not proof of Web App authentication. Only the `authenticated` event means the bootstrap reported a successful redemption response. Protected pages/APIs must still be authorized by the Web App backend.

## HandoffCallback screen

1. Add optional Text inputs named exactly `code` and `attempt` to match the Web App query parameters.
2. OnReady, invoke `CompleteHandoff` once. Show a neutral completing-sign-in state underneath the native browser.
3. Do not call the original InAppBrowser's Open or Close actions from this screen.
4. Do not call the redemption API through OutSystems REST/server actions/native HTTP.
5. Do not auto-close this plugin from the originating screen's OnDestroy.
6. If no pending attempt exists, show Retry and start a new flow. Do not create a new WebView merely to redeem an old code.
7. Keep this route under the existing mobile app's normal authenticated-access policy. An incoming callback alone must not authenticate an OutSystems user. If the mobile session expired, restart through normal login.
8. After the native browser is closed, navigate to a clean normal route so callback parameters are not retained in navigation history. Never display or log the code.

Android uses the screen route. iOS's native auth session normally handles the callback without visiting the screen.

## GetHandoffState

Output: `StateJson` (Text). Synchronous JavaScript:

```javascript
var p = window.cordova && cordova.plugins && cordova.plugins.MiraInAppBrowser;
$parameters.StateJson = JSON.stringify(p ? p.getState() : { phase: 'unavailable' });
```

In 0.1.1 this also returns `lastBlockedOrigin` and `lastError` when present. `lastError` retains safe load metadata after automatic closure: `code`, `message`, and where available `nativeErrorDomain`, `nativeErrorCode` or `httpStatus`. Log this state through your existing Server Action/System.LogMessage on both the opening success and failure branches. No handoff code, cookies, full callback URL or native error description should be logged. Read the state before starting a new attempt because `open` resets diagnostics. A host reload also resets them.

## CloseHandoffBrowser

Use `cordova.plugins.MiraInAppBrowser.close(success, error)` from an asynchronous wrapper action. Close refers exclusively to this plugin. To retry, close then start again after native dismissal finishes; on iOS a presentation-busy response during animation can require waiting for return to the host screen before reopening.

## First staging test

Agree on the Web App bridge helper before testing; their current backend endpoints alone do not supply the native bridge. Configure the actual module callback paths, install both plugins in one MABS build, then test Android and iOS separately. Start with one active attempt and a clean Web App session, then cover an existing session, cancellation, wrong attempt, timeout, repeated callback, backgrounding, reload and process termination.
