# Version 0.1.3 — separate initial SSO and chatbot handoff URLs

Added optional same-origin HTTPS `initialUrl` to the controller and both native implementations. The retained WebView loads this URL first; the configured `bootstrapUrl` still determines the exact origin/path allowed to exchange handoff messages. Omitting `initialUrl` preserves existing behavior. Staging configuration starts at `/azure-sso` and receives the later button request at `/maia-personal-assistant`.

Validation: `npm test` passed all 31 tests; `npm run check` passed; plugin source-directory validation passed. The two new tests exercise separate URL forwarding and deferred login for both platform controller paths, default compatibility, and rejection of cross-origin, insecure, credential-bearing or fragmented entry URLs. Native redirects, MABS builds and device behavior have not been tested. The earlier 0.1.2 ZIP does not include this change; build from the updated PR commit.

This does not resolve an initial WebView SSO that itself requires passkeys. One handoff per open and existing upload/download limitations remain.

---

# Version 0.1.2 — chatbot button handoff

Changes: opt-in `authenticationMode: 'onDemand'`, a deadline that begins when the button supplies a valid attempt, helper bridge preflight and cleanup after a failed first send or component teardown, and integration instructions for the chatbot route. Default bootstrap-first behavior is retained. Native Android/iOS message handlers now forward the optional signInUrl internally. The controller validates its endpoint, attempt, platform and configured parameters before launch. Origin/path restrictions and native browser ownership are unchanged.

Validation performed for this change:

- `npm test`: 29 tests passed (17 existing, 12 added). Covers idle chatbot beyond the login timeout; Android and iOS controller callback paths; duplicate, unsolicited, mismatched and expired callbacks; legacy deadline behavior; missing bridge; first-send failure; stale component cleanup and in-flight redemption teardown; server-generated continuation preservation and rejection of unsafe/mismatched login URLs.
- `npm run check`: both JavaScript files passed syntax checks.
- Plugin source-directory validator: valid with the package root named `inappbrowser-mira`. Existing plugin identity retained for compatibility; GitHub repository name may differ from the package ID.

Not performed: native Android/iOS compilation, MABS generation/signing, or physical-device validation. JavaScript harnesses mock Cordova/native callbacks; they do not prove platform UI behavior, Zscaler access, Microsoft token acquisition or Conditional Access success.

Device integration gates: generate/install the new package; invoke OpenChatBrowser instead of standard OpenInWebView; confirm bridge presence on the exact chatbot route; idle longer than 10 minutes then tap; verify the actual `/azure-sso` continuation contract; finish passkey/callback/redemption; resume OneDrive; check cancellation and reopen, gateway redirects, page reload, backgrounding and duplicate taps on both platforms. Native file upload/download features remain outside this plugin's current scope. One authentication cycle per open is supported.

---

# Validation — 2026-09-16

Version: `0.1.1`. Status: staging integration candidate, not a production-validated native release.

## 0.1.1 update

- Added opt-in exact HTTPS navigation origins for access-gateway redirects on Android and iOS. Bridge source/origin/path checks and handoff destination checks remain restricted to the original Web App.
- Added origin-only blocked-navigation diagnostics and native error domain/code or main-document HTTP status. Last failure survives `idle` until the next attempt; sensitive native descriptions and full URLs are excluded.
- All 17 JavaScript tests and syntax checks passed. New cases cover navigation-origin input rejection, unchanged authentication-origin restriction, sanitized errors and retained/reset diagnostic state.
- Static OutSystems package validation passed. The updated plugin was removed/reinstalled on both platforms in the existing Android 14.0.1 / iOS 7.1.1 coexistence project, and Cordova prepare passed. Both distinct services remain registered.
- Native compilation and device execution of this update were not performed. Test the actual gateway chain and bootstrap callback in new MABS-generated binaries. The navigation change addresses a blocked redirect; it does not establish the underlying cause of every iOS load error.

## Original 0.1.0 baseline

| Check | Result |
| --- | --- |
| JavaScript syntax | `npm run check` passed for controller and bootstrap helper |
| Controller/bootstrap tests | 12 tests passed using Node's built-in runner |
| Cordova metadata | Parsed with cordova-common; correct ID/version and both platform entries |
| OutSystems package validation | Valid plugin tree; all required referenced sources present |
| Android coexistence installation | Original plugin and new plugin installed together in a fresh cordova-android 14.0.1 project |
| iOS coexistence installation | Original plugin and new plugin installed together in a fresh cordova-ios 7.1.1 project |
| Cordova prepare | Passed for the combined test project |
| Generated platform configuration | Both OSInAppBrowser and MiraInAppBrowser services present with distinct native implementations |
| Existing checkout | Remains clean on fix/ios-teams-links at 68c0ed3442e2ce2946162442b4e5385bb4e7acd1 |

The package validator suggests the conventional `cordova-plugin-*` prefix. The requested exact name `inappbrowser-mira` is npm-safe, lowercase, hyphenated and is used consistently for the package, Cordova ID, archive root and resource configuration.

Tests cover callback route validation, mismatched/expired/duplicate callbacks, stale callback isolation, origin configuration restrictions, redemptions in the WebView cookie context, navigation acknowledgement, failed redemption, and an already authenticated bootstrap. Native UI behavior is not simulated by those tests.

## Not performed

- Native Android compilation: this environment has no configured Android SDK or Gradle installation. Cordova requirements check confirms missing build prerequisites.
- Native iOS compilation: this environment is Linux and has no macOS/Xcode toolchain.
- MABS resolver/build/signing: needs the actual OutSystems application and build service.
- Physical iOS/Android testing: no devices or installed app builds are connected.
- Live Web App/Entra authentication: not attempted. The Web App bridge contract and final mobile callback module paths still need agreement.

These Cordova versions are upstream installation probes, not a claim about the exact Cordova versions inside the user's current MABS build. Recheck against the actual MABS log.

## Required staging gates

1. Build/install with both the original InAppBrowser plugin and this plugin in the same mobile app. Confirm neither service is replaced and existing screens still use the original plugin.
2. Confirm the Web App bootstrap implements `docs/WEB-APP-CONTRACT.md`; confirm JWT/database session creation with its actual NextAuth configuration.
3. Test actual Android and iOS callback URLs. Verify iOS auth-session interception and Android callback screen processing separately.
4. Verify passkey availability under the actual Entra policy and supported platform/browser.
5. Verify original binding cookie survives browser authentication; verify replay, wrong WebView, account mismatch and timeout are rejected server-side.
6. Verify successful page/API access, logout and existing-session behavior.
7. Test cancel, Close, repeated open, browser Back, orientation change, background/foreground, host reload and process death. A lost attempt must restart.
8. Confirm Android Custom Tab return/dismissal and the retained native Dialog on target devices. No universal auto-close claim is made.
9. Verify Web App capabilities needed beyond login. File uploads, downloads and external app links are outside v0.1 scope and must not be assumed to match the original fork.

Do not promote this build until these gates are complete.
