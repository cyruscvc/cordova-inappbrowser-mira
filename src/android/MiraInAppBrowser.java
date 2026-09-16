package com.mira.inappbrowser;

import android.annotation.SuppressLint;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Owns only this plugin's Dialog/WebView. No static/global browser hooks. */
public final class MiraInAppBrowser extends CordovaPlugin {
    private Dialog dialog;
    private WebView browser;
    private CallbackContext events;
    private Uri bootstrap;
    private Uri authStart;
    private String origin;
    private boolean delivered;
    private Set<String> navigationOrigins = Collections.emptySet();

    @Override public boolean execute(String action, JSONArray args, CallbackContext callback) {
        if (!action.equals("open") && !action.equals("openAuth") && !action.equals("deliverHandoff") && !action.equals("close")) return false;
        cordova.getActivity().runOnUiThread(() -> {
            try {
                switch (action) {
                    case "open": open(args.getJSONObject(0), callback); break;
                    case "openAuth": openAuth(args.getJSONObject(0), callback); break;
                    case "deliverHandoff": deliver(args.getJSONObject(0), callback); break;
                    case "close": closeOwned(true); callback.success(); break;
                }
            } catch (Exception ignored) {
                callback.error(error("NATIVE_ERROR", "Browser operation failed."));
            }
        });
        return true;
    }

    private JSONObject error(String code, String message) {
        JSONObject result = new JSONObject();
        try { result.put("code", code); result.put("message", message); } catch (JSONException ignored) { }
        return result;
    }
    private JSONObject event(String type) {
        JSONObject result = new JSONObject();
        try { result.put("type", type); } catch (JSONException ignored) { }
        return result;
    }
    private void emit(JSONObject value, boolean keep) {
        if (events == null) return;
        PluginResult result = new PluginResult(PluginResult.Status.OK, value);
        result.setKeepCallback(keep);
        events.sendPluginResult(result);
        if (!keep) events = null;
    }
    private static String origin(Uri value) {
        if (value == null || !"https".equals(value.getScheme()) || value.getHost() == null || value.getUserInfo() != null) return "";
        int port = value.getPort();
        return "https://" + value.getHost().toLowerCase(java.util.Locale.ROOT) + ((port == -1 || port == 443) ? "" : ":" + port);
    }
    private boolean trusted(Uri value) { return value != null && origin != null && origin.equals(origin(value)); }
    private boolean navigationAllowed(Uri value) { return trusted(value) || navigationOrigins.contains(origin(value)); }
    private JSONObject navigationBlocked(Uri value) {
        JSONObject result = event("navigation.blocked");
        try { result.put("origin", origin(value)); } catch (JSONException ignored) { }
        return result;
    }
    private JSONObject loadError(int code, boolean http) {
        JSONObject result = event("load.error");
        try {
            if (http) result.put("httpStatus", code);
            else { result.put("nativeErrorDomain", "AndroidWebView"); result.put("nativeErrorCode", code); }
        } catch (JSONException ignored) { }
        return result;
    }
    private boolean bootstrapPage(Uri value) {
        return trusted(value) && bootstrap != null && bootstrap.getEncodedPath().equals(value.getEncodedPath());
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void open(JSONObject options, CallbackContext callback) throws JSONException {
        if (browser != null) { callback.error(error("BUSY", "The handoff browser is already open.")); return; }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            callback.error(error("WEBVIEW_UNSUPPORTED", "Update Android System WebView to enable the restricted bridge.")); return;
        }
        bootstrap = Uri.parse(options.getString("bootstrapUrl"));
        authStart = Uri.parse(options.getString("authStartUrl"));
        origin = origin(bootstrap);
        if (origin.isEmpty() || !trusted(authStart)) { callback.error(error("INVALID_OPTIONS", "Expected matching HTTPS origins.")); return; }
        Set<String> allowed = new HashSet<>();
        JSONArray entries = options.optJSONArray("allowedNavigationOrigins");
        if ((options.has("allowedNavigationOrigins") && entries == null) || (entries != null && entries.length() > 8)) {
            callback.error(error("INVALID_OPTIONS", "Expected exact HTTPS navigation origins.")); return;
        }
        for (int i = 0; entries != null && i < entries.length(); i++) {
            String raw = entries.getString(i);
            Uri entry = Uri.parse(raw);
            String normalized = origin(entry);
            if (normalized.isEmpty() || raw.contains("*") || !(raw.equals(normalized) || raw.equals(normalized + "/"))) {
                callback.error(error("INVALID_OPTIONS", "Expected exact HTTPS navigation origins.")); return;
            }
            allowed.add(normalized);
        }
        navigationOrigins = allowed;
        events = callback;
        delivered = false;
        WebView owned = new WebView(cordova.getActivity());
        browser = owned;
        WebSettings settings = owned.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(owned, false);
        owned.setBackgroundColor(Color.WHITE);

        WebViewCompat.addWebMessageListener(owned, "MiraHandoffNative", Collections.singleton(origin),
            (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                if (view != browser || !isMainFrame || !trusted(sourceOrigin) || !bootstrapPage(Uri.parse(view.getUrl() == null ? "" : view.getUrl()))) return;
                try {
                    String raw = message.getData();
                    if (raw == null || raw.length() > 8192) return;
                    JSONObject data = new JSONObject(raw);
                    String type = data.optString("type");
                    if (type.equals("bootstrap.ready") || type.equals("handoff.complete") || type.equals("handoff.error") || type.equals("session.ready")) {
                        // Never forward arbitrary page fields (or credentials) to app events.
                        JSONObject safe = event(type);
                        if (data.has("attempt")) safe.put("attempt", data.optString("attempt"));
                        emit(safe, true);
                        if (type.equals("handoff.complete") || type.equals("session.ready")) {
                            JSONObject ack = event("handoff.accepted");
                            if (data.has("attempt")) ack.put("attempt", data.optString("attempt"));
                            dispatch(owned, ack, null);
                        }
                    }
                } catch (Exception ignored) { /* Untrusted/invalid page message: ignore. */ }
            });

        owned.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                if (navigationAllowed(request.getUrl())) return false;
                if (view == browser) emit(navigationBlocked(request.getUrl()), true);
                return true;
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (view == browser && request.isForMainFrame()) emit(loadError(error.getErrorCode(), false), true);
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (view == browser && request.isForMainFrame()) emit(loadError(response.getStatusCode(), true), true);
            }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                if (view == browser) { emit(event("load.error"), true); closeOwned(false); }
                return true;
            }
        });

        Dialog ownedDialog = new Dialog(cordova.getActivity(), android.R.style.Theme_Material_Light_NoActionBar);
        dialog = ownedDialog;
        ownedDialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout root = new LinearLayout(cordova.getActivity());
        root.setOrientation(LinearLayout.VERTICAL);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(Color.WHITE);
        Button close = new Button(cordova.getActivity());
        close.setText("Close");
        close.setContentDescription("Close web app");
        close.setOnClickListener(v -> closeOwned(true));
        int height = (int) (48 * cordova.getActivity().getResources().getDisplayMetrics().density);
        root.addView(close, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height));
        root.addView(owned, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        ownedDialog.setContentView(root);
        ownedDialog.setOnCancelListener(d -> closeOwned(true));
        ownedDialog.show();
        Window window = ownedDialog.getWindow();
        if (window != null) {
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        }
        owned.loadUrl(bootstrap.toString());
        emit(event("opened"), true);
    }

    private void openAuth(JSONObject input, CallbackContext callback) throws JSONException {
        if (browser == null || !bootstrapPage(Uri.parse(browser.getUrl() == null ? "" : browser.getUrl()))) {
            callback.error(error("NO_WEBVIEW", "The original bootstrap page is unavailable.")); return;
        }
        Uri target = Uri.parse(input.getString("url"));
        if (!trusted(target) || !authStart.getEncodedPath().equals(target.getEncodedPath())) {
            callback.error(error("INVALID_AUTH_URL", "Unexpected sign-in URL.")); return;
        }
        // Crucially: keep our Dialog and WebView; never call the existing plugin's close.
        CustomTabsIntent tab = new CustomTabsIntent.Builder().setShowTitle(false).build();
        tab.intent.addFlags(Intent.FLAG_ACTIVITY_NO_HISTORY);
        tab.launchUrl(cordova.getActivity(), target);
        callback.success();
    }

    private void deliver(JSONObject input, CallbackContext callback) throws JSONException {
        if (browser == null || delivered || !bootstrapPage(Uri.parse(browser.getUrl() == null ? "" : browser.getUrl()))) {
            callback.error(error("DELIVERY_FAILED", "The original bootstrap page is unavailable or already received a code.")); return;
        }
        String code = input.getString("code");
        String attempt = input.getString("attempt");
        if (code.isEmpty() || code.length() > 4096 || !attempt.matches("[A-Za-z0-9_-]{1,256}")) {
            callback.error(error("INVALID_CALLBACK", "Invalid handoff values.")); return;
        }
        JSONObject data = event("auth.handoff");
        data.put("attempt", attempt); data.put("code", code);
        delivered = true;
        dispatch(browser, data, callback);
    }

    private void dispatch(WebView owned, JSONObject data, CallbackContext callback) {
        if (browser != owned) { if (callback != null) callback.error(error("NO_WEBVIEW", "Browser closed.")); return; }
        // JSON encoding plus a guard evaluated inside the document prevents navigation races.
        String script = "(function(){if(location.origin!==" + JSONObject.quote(origin) + "||location.pathname!==" +
            JSONObject.quote(bootstrap.getEncodedPath()) + ")return false;window.dispatchEvent(new CustomEvent('mira:native',{detail:" + data.toString() + "}));return true;})()";
        owned.evaluateJavascript(script, result -> {
            if (callback != null) {
                if (browser == owned && "true".equals(result)) callback.success();
                else callback.error(error("DELIVERY_FAILED", "Bootstrap document changed."));
            }
        });
    }

    private void closeOwned(boolean notify) {
        Dialog oldDialog = dialog; dialog = null;
        WebView oldBrowser = browser; browser = null;
        if (oldDialog != null) { oldDialog.setOnCancelListener(null); oldDialog.dismiss(); }
        if (oldBrowser != null) {
            oldBrowser.stopLoading();
            if (oldBrowser.getParent() instanceof ViewGroup) ((ViewGroup) oldBrowser.getParent()).removeView(oldBrowser);
            WebViewCompat.removeWebMessageListener(oldBrowser, "MiraHandoffNative");
            oldBrowser.destroy();
        }
        if (notify) emit(event("closed"), false);
        else if (events != null) {
            PluginResult end = new PluginResult(PluginResult.Status.NO_RESULT); end.setKeepCallback(false);
            events.sendPluginResult(end); events = null;
        }
        // Do not clear shared cookies, WebStorage or any other plugin's state.
    }
    @Override public void onReset() { cordova.getActivity().runOnUiThread(() -> closeOwned(false)); }
    @Override public void onDestroy() { cordova.getActivity().runOnUiThread(() -> closeOwned(false)); }
}
