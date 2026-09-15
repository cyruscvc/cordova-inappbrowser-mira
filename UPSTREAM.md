# Provenance and publishing

This plugin was derived from `cyruscvc/cordova-outsystems-inappbrowser`, branch `fix/ios-teams-links`, commit `68c0ed3442e2ce2946162442b4e5385bb4e7acd1`.

The upstream MIT license is retained. The new working tree replaces the original generic browser implementation with a dedicated, separately named implementation for this authentication handoff. It does not copy the old binary AAR or Swift library into the new installable plugin, avoiding duplicate native symbols and resources when both plugins are installed.

The original repository is unchanged. Its history is retained in a separate local repository bundle; this public repository starts with the dedicated plugin source only.

## Repository

Source: [cyruscvc/cordova-inappbrowser-mira](https://github.com/cyruscvc/cordova-inappbrowser-mira).

The GitHub repository name is `cordova-inappbrowser-mira`; the Cordova/npm package ID and ZIP root remain `inappbrowser-mira`. The native service and JavaScript API remain `MiraInAppBrowser`.

```sh
git clone https://github.com/cyruscvc/cordova-inappbrowser-mira.git
```

This is a separate repository, rather than a GitHub fork-network relationship. Environment URLs and app callback values are supplied by the consuming application; examples use placeholder domains.

## References

- Android restricted bridge: https://developer.android.com/reference/androidx/webkit/WebViewCompat#addWebMessageListener(android.webkit.WebView,java.lang.String,java.util.Set,androidx.webkit.WebViewCompat.WebMessageListener)
- Apple authentication browser: https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession
- OutSystems deep links: https://success.outsystems.com/documentation/how_to_guides/development/how_to_define_mobile_app_deep_links/
- NextAuth session options: https://next-auth.js.org/configuration/options
