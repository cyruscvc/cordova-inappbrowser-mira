# inappbrowser-mira

Dedicated Cordova plugin for an OutSystems 11 mobile app that opens an external Web App fullscreen, temporarily authenticates through the system browser, and redeems a one-time handoff inside the original WebView.

Repository: [cyruscvc/cordova-inappbrowser-mira](https://github.com/cyruscvc/cordova-inappbrowser-mira). Package ID: `inappbrowser-mira`.

**Version 0.1.0 is a staging integration candidate. Native compilation, signing and physical-device validation are required before deployment.** See `VALIDATION.md` for the checks actually performed.

## Isolation

| Item | This plugin | Existing plugin |
| --- | --- | --- |
| Package and Cordova ID | `inappbrowser-mira` | `com.outsystems.plugins.inappbrowser` |
| JavaScript API | `cordova.plugins.MiraInAppBrowser` | `cordova.plugins.OSInAppBrowser` |
| Cordova service | `MiraInAppBrowser` | `OSInAppBrowser` |
| Android implementation | `com.mira.inappbrowser.MiraInAppBrowser` | Existing package remains unchanged |
| iOS classes | `MiraInAppBrowser`, `MiraHandoffViewController` | Existing classes remain unchanged |

The new implementation does not bundle the original Android AAR or Swift library, does not call the original plugin, and does not clear global cookies/storage. It registers no global deep-link interception and no new app URL scheme. AndroidX dependencies are resolved by the host Gradle project; final coexistence needs a device build.

It provides a dedicated authentication browser, not a drop-in replacement for all original browsing APIs. Mixed-file upload customizations, downloads/exports, Teams deep links and cross-origin navigation are not implemented in this first version. Keep existing features wired to the original plugin. This browser currently permits only same-origin top-level Web App navigation, and displays a native Close control without URL/browser toolbars.

## Flow

1. `open` creates and retains a native WebView at the configured HTTPS bootstrap URL.
2. The Web App sets an independent HttpOnly binding cookie and signals `bootstrap.ready` with the attempt ID.
3. `authenticate` opens the configured sign-in URL with `attempt` and `platform` parameters. The WebView remains retained.
4. The Web App runs its own Entra/NextAuth login and returns a one-time handoff code to the app callback.
5. iOS receives the callback through `ASWebAuthenticationSession`. Android's existing OutSystems deep-link route forwards its screen inputs to `completeHandoff`.
6. The controller checks the pending attempt and sends the code only to the original, same-origin bootstrap document.
7. The bootstrap page POSTs the code with its binding cookie, confirms successful session creation, and navigates to the approved destination.

There is no passkey implementation inside the WebView. Authentication happens in Android Custom Tabs / iOS ASWebAuthenticationSession; availability still depends on Entra policies, the OS and the browser.

## API

```javascript
const browser = cordova.plugins.MiraInAppBrowser;
browser.open({
  bootstrapUrl: 'https://web.example.test/auth/mobile/bootstrap',
  authStartUrl: 'https://web.example.test/azure-sso',
  callbackUrl: 'com.example.mobile://MobileModule/HandoffCallback',
  platform: cordova.platformId, // "android" or "ios"
  timeoutSeconds: 600
}, function onEvent(event) {
  if (event.type === 'ready') browser.authenticate(function () {}, handleError);
  // Other safe events: opened, authStarted, redeeming, authenticated,
  // navigationBlocked, closed. No handoff code is included in public events.
}, handleError);

function handleError(error) {
  // Display a recoverable message. Do not log callback URLs or credentials.
}
```

| Method | Purpose |
| --- | --- |
| `open(options, onEvent, onError)` | Opens the dedicated browser; one active instance only |
| `authenticate(success, error)` | Opens system authentication after `ready` |
| `completeHandoff({code, attempt}, success, error)` | Accepts the OutSystems callback screen inputs; success means delivery, not completed login |
| `handleCallback(url, success, error)` | Validates the full exact callback route and its two query parameters |
| `getState()` | Returns phase, pending attempt and deadline; never the code |
| `close(success, error)` | Closes this plugin's browser only |

The Cordova module owns the pending state across ordinary OutSystems screen navigation. A full host reload, process termination, or destroyed native WebView loses the attempt and requires a new bootstrap. Do not store the code in persistent Client Variables. Do not call `close` from the launching screen's OnDestroy merely because deep-link navigation opened the callback screen.

## Platform behavior

- Android: the existing installed app must already register its actual OutSystems custom URL scheme and route. The callback screen calls `completeHandoff`. The plugin does not override `handleOpenURL` or register a competing intent filter. Custom Tabs stays separate from the retained WebView. Returning/dismissing Chrome varies by device; test callback return, Android Back and repeated login. Browser cancellation is handled by returning to the retained WebView and pressing Close, or by the overall timeout; there is no claim of automatic Custom Tab dismissal/cancellation reporting on every browser.
- iOS: ASWebAuthenticationSession captures the configured custom scheme and automatically forwards its full callback to the controller. The callback screen may therefore never be displayed. Do not require a second screen callback on iOS. The controller tolerates a duplicate native URL callback after processing has begun.
- v0.1 supports custom-scheme callbacks only. Universal/App Link callbacks require an additional platform-specific implementation; HTTPS callback configuration is deliberately rejected.
- Requires iOS 13+ and Android with `WEB_MESSAGE_LISTENER` support. Android source uses API 26+ lifecycle callbacks; align the host minimum/compile SDK with the current MABS build.

## Integration documents

- `docs/OUTSYSTEMS.md`: wrapper module, resource setup, JavaScript nodes and callback inputs.
- `docs/WEB-APP-CONTRACT.md`: exact bridge messages and redemption contract to agree with the Web App team.
- `web/mira-handoff.js`: self-hosted bootstrap helper for the Web App.
- `VALIDATION.md`: completed checks and outstanding native/device gates.
- `UPSTREAM.md`: provenance, license, isolated repository and publishing instructions.

## Development

`npm test` runs controller and bootstrap-helper tests using Node's built-in test runner. `npm run check` validates JavaScript syntax. There are no runtime npm dependencies and no build-time Vite bundle.

Package using the OutSystems plugin-creator packager, ensuring the ZIP root, ZIP basename, plugin ID and npm name are all `inappbrowser-mira`.
