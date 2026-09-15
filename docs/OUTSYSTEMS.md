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
  timeoutSeconds: 600
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

## CompleteHandoff

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

## CloseHandoffBrowser

Use `cordova.plugins.MiraInAppBrowser.close(success, error)` from an asynchronous wrapper action. Close refers exclusively to this plugin. To retry, close then start again after native dismissal finishes; on iOS a presentation-busy response during animation can require waiting for return to the host screen before reopening.

## First staging test

Agree on the Web App bridge helper before testing; their current backend endpoints alone do not supply the native bridge. Configure the actual module callback paths, install both plugins in one MABS build, then test Android and iOS separately. Start with one active attempt and a clean Web App session, then cover an existing session, cancellation, wrong attempt, timeout, repeated callback, backgrounding, reload and process termination.
