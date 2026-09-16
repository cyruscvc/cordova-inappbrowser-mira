import Foundation
import UIKit
import WebKit
import AuthenticationServices

@available(iOS 13.0, *)
@objc(MiraInAppBrowser)
final class MiraInAppBrowser: CDVPlugin, WKScriptMessageHandler, WKNavigationDelegate, ASWebAuthenticationPresentationContextProviding {
    private var browser: WKWebView?
    private var controller: MiraHandoffViewController?
    private var events: String?
    private var bootstrap: URL?
    private var authStart: URL?
    private var callbackURL: URL?
    private var authSession: ASWebAuthenticationSession?
    private var authID: UUID?
    private var delivered = false
    private var navigationOrigins = Set<String>()

    private func origin(_ url: URL?) -> String? {
        guard let url = url, url.scheme?.lowercased() == "https", let host = url.host?.lowercased(), url.user == nil, url.password == nil else { return nil }
        let port = url.port.flatMap { $0 == 443 ? nil : ":\($0)" } ?? ""
        return "https://\(host)\(port)"
    }
    private func path(_ url: URL?) -> String? {
        guard let url = url else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath
    }
    private func trusted(_ url: URL?) -> Bool {
        guard let base = origin(bootstrap), let other = origin(url) else { return false }
        return base == other
    }
    private func bootstrapPage(_ url: URL?) -> Bool { trusted(url) && path(url) == path(bootstrap) }
    private func navigationAllowed(_ url: URL?) -> Bool {
        guard let value = origin(url) else { return false }
        return trusted(url) || navigationOrigins.contains(value)
    }
    private func loadError(_ error: Error) {
        let native = error as NSError
        // NSError.userInfo and localizedDescription can contain sensitive URLs.
        emit(["type": "load.error", "nativeErrorDomain": native.domain, "nativeErrorCode": native.code])
    }
    private func success(_ command: CDVInvokedUrlCommand) {
        commandDelegate.send(CDVPluginResult(status: .ok), callbackId: command.callbackId)
    }
    private func error(_ command: CDVInvokedUrlCommand, _ code: String, _ message: String) {
        commandDelegate.send(CDVPluginResult(status: .error, messageAs: ["code": code, "message": message]), callbackId: command.callbackId)
    }
    private func emit(_ value: [String: Any], keep: Bool = true) {
        guard let id = events, let result = CDVPluginResult(status: .ok, messageAs: value) else { return }
        result.keepCallback = NSNumber(value: keep)
        commandDelegate.send(result, callbackId: id)
        if !keep { events = nil }
    }

    @objc(open:)
    func open(_ command: CDVInvokedUrlCommand) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard self.browser == nil else { self.error(command, "BUSY", "The handoff browser is already open."); return }
            guard let opts = command.argument(at: 0) as? [String: Any],
                  let b = opts["bootstrapUrl"] as? String, let bootstrap = URL(string: b),
                  let a = opts["authStartUrl"] as? String, let auth = URL(string: a),
                  let c = opts["callbackUrl"] as? String, let callback = URL(string: c),
                  self.origin(bootstrap) != nil, self.origin(bootstrap) == self.origin(auth),
                  let scheme = callback.scheme, scheme != "https", scheme != "http" else {
                self.error(command, "INVALID_OPTIONS", "Expected HTTPS Web App URLs and an app callback."); return
            }
            // Do not dismiss an existing plugin's view controller to make room for ours.
            guard self.viewController.presentedViewController == nil else {
                self.error(command, "PRESENTATION_BUSY", "Close other presented views before opening the handoff browser."); return
            }
            let rawNavigation = opts["allowedNavigationOrigins"] ?? [String]()
            guard let entries = rawNavigation as? [String], entries.count <= 8 else {
                self.error(command, "INVALID_OPTIONS", "Expected exact HTTPS navigation origins."); return
            }
            var allowed = Set<String>()
            for raw in entries {
                guard let entry = URL(string: raw), let normalized = self.origin(entry), !raw.contains("*"),
                      raw == normalized || raw == normalized + "/" else {
                    self.error(command, "INVALID_OPTIONS", "Expected exact HTTPS navigation origins."); return
                }
                allowed.insert(normalized)
            }
            self.navigationOrigins = allowed
            self.bootstrap = bootstrap; self.authStart = auth; self.callbackURL = callback
            self.events = command.callbackId; self.delivered = false
            let config = WKWebViewConfiguration()
            config.websiteDataStore = .default()
            config.userContentController.add(self, name: "MiraHandoffNative")
            let web = WKWebView(frame: .zero, configuration: config)
            web.navigationDelegate = self
            web.allowsBackForwardNavigationGestures = true
            self.browser = web
            let screen = MiraHandoffViewController(web: web) { [weak self] in self?.closeOwned(notify: true) }
            screen.modalPresentationStyle = .fullScreen
            self.controller = screen
            self.viewController.present(screen, animated: true) { [weak self, weak web] in
                guard let self = self, let web = web, self.browser === web else { return }
                web.load(URLRequest(url: bootstrap))
                self.emit(["type": "opened"])
            }
        }
    }

    @objc(openAuth:)
    func openAuth(_ command: CDVInvokedUrlCommand) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let web = self.browser, self.bootstrapPage(web.url), self.authSession == nil,
                  let input = command.argument(at: 0) as? [String: Any], let raw = input["url"] as? String,
                  let target = URL(string: raw), self.trusted(target), self.path(target) == self.path(self.authStart),
                  let callbackScheme = self.callbackURL?.scheme else {
                self.error(command, "INVALID_STATE", "The original bootstrap page or sign-in URL is unavailable."); return
            }
            let id = UUID(); self.authID = id
            let session = ASWebAuthenticationSession(url: target, callbackURLScheme: callbackScheme) { [weak self, weak web] url, err in
                DispatchQueue.main.async {
                    guard let self = self, let web = web, self.browser === web, self.authID == id else { return }
                    self.authID = nil; self.authSession = nil
                    if let url = url {
                        self.emit(["type": "auth.callback", "url": url.absoluteString])
                    } else if (err as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                        self.emit(["type": "auth.cancelled"])
                    } else {
                        self.emit(["type": "load.error"])
                    }
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.authSession = session
            if session.start() { self.success(command) }
            else { self.authSession = nil; self.authID = nil; self.error(command, "BROWSER_FAILED", "The authentication browser could not open.") }
        }
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return controller?.view.window ?? viewController.view.window ?? ASPresentationAnchor()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let web = browser, message.webView === web, message.name == "MiraHandoffNative", message.frameInfo.isMainFrame,
              bootstrapPage(web.url) else { return }
        let source = message.frameInfo.securityOrigin
        let sourcePort = source.port == 0 || source.port == 443 ? "" : ":\(source.port)"
        guard "\(source.protocol)://\(source.host.lowercased())\(sourcePort)" == origin(bootstrap) else { return }
        let data: [String: Any]?
        if let raw = message.body as? String, raw.utf8.count <= 8192, let bytes = raw.data(using: .utf8) {
            data = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
        } else { data = nil }
        guard let value = data, let type = value["type"] as? String,
              ["bootstrap.ready", "handoff.complete", "handoff.error", "session.ready"].contains(type) else { return }
        var safe: [String: Any] = ["type": type]
        if let attempt = value["attempt"] as? String { safe["attempt"] = attempt }
        emit(safe)
        if type == "handoff.complete" || type == "session.ready" {
            safe["type"] = "handoff.accepted"
            dispatch(safe, web: web, completion: nil)
        }
    }

    @objc(deliverHandoff:)
    func deliverHandoff(_ command: CDVInvokedUrlCommand) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let web = self.browser, self.bootstrapPage(web.url), !self.delivered,
                  let input = command.argument(at: 0) as? [String: Any],
                  let code = input["code"] as? String, !code.isEmpty, code.utf8.count <= 4096,
                  let attempt = input["attempt"] as? String,
                  attempt.range(of: "^[A-Za-z0-9_-]{1,256}$", options: .regularExpression) != nil else {
                self.error(command, "DELIVERY_FAILED", "The original bootstrap page is unavailable or already received a code."); return
            }
            self.delivered = true
            self.authID = nil
            self.authSession?.cancel(); self.authSession = nil
            self.dispatch(["type": "auth.handoff", "attempt": attempt, "code": code], web: web) { [weak self, weak web] ok in
                guard let self = self else { return }
                if ok && web != nil && self.browser === web { self.success(command) }
                else { self.error(command, "DELIVERY_FAILED", "Bootstrap document changed.") }
            }
        }
    }
    private func dispatch(_ data: [String: Any], web: WKWebView, completion: ((Bool) -> Void)?) {
        guard browser === web, let origin = origin(bootstrap), let path = path(bootstrap),
              let bytes = try? JSONSerialization.data(withJSONObject: ["origin": origin, "path": path, "payload": data]),
              let json = String(data: bytes, encoding: .utf8) else { completion?(false); return }
        let script = "(function(){const m=\(json);if(location.origin!==m.origin||location.pathname!==m.path)return false;window.dispatchEvent(new CustomEvent('mira:native',{detail:m.payload}));return true;})()"
        web.evaluateJavaScript(script) { value, error in completion?(error == nil && (value as? Bool) == true) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        if navigationAllowed(navigationAction.request.url) { decisionHandler(.allow) }
        else {
            if webView === browser { emit(["type": "navigation.blocked", "origin": origin(navigationAction.request.url) ?? ""]) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if webView === browser, navigationResponse.isForMainFrame,
           let response = navigationResponse.response as? HTTPURLResponse, response.statusCode >= 400 {
            emit(["type": "load.error", "httpStatus": response.statusCode])
            decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let native = error as NSError
        if webView === browser && !(native.domain == NSURLErrorDomain && native.code == NSURLErrorCancelled) { loadError(error) }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let native = error as NSError
        if webView === browser && !(native.domain == NSURLErrorDomain && native.code == NSURLErrorCancelled) { loadError(error) }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === browser { emit(["type": "load.error"]); closeOwned(notify: false) }
    }
    @objc(close:)
    func close(_ command: CDVInvokedUrlCommand) {
        DispatchQueue.main.async { [weak self] in self?.closeOwned(notify: true); self?.success(command) }
    }
    private func closeOwned(notify: Bool) {
        authID = nil; authSession?.cancel(); authSession = nil
        let old = controller; controller = nil
        browser?.stopLoading()
        browser?.configuration.userContentController.removeScriptMessageHandler(forName: "MiraHandoffNative")
        browser?.navigationDelegate = nil; browser = nil
        old?.dismiss(animated: true)
        if notify { emit(["type": "closed"], keep: false) }
        else if let id = events, let result = CDVPluginResult(status: .noResult) {
            result.keepCallback = false; commandDelegate.send(result, callbackId: id); events = nil
        }
        // No shared cookie/cache deletion and no modification of another plugin's controller.
    }
    override func onReset() { DispatchQueue.main.async { [weak self] in self?.closeOwned(notify: false) } }
}

@available(iOS 13.0, *)
private final class MiraHandoffViewController: UIViewController {
    private let web: WKWebView
    private let onClose: () -> Void
    init(web: WKWebView, onClose: @escaping () -> Void) {
        self.web = web; self.onClose = onClose; super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("Use init(web:onClose:)") }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        let close = UIButton(type: .system)
        close.setTitle("Close", for: .normal); close.accessibilityLabel = "Close web app"
        close.addTarget(self, action: #selector(closePressed), for: .touchUpInside)
        close.translatesAutoresizingMaskIntoConstraints = false; web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(close); view.addSubview(web)
        NSLayoutConstraint.activate([
            close.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            close.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            close.heightAnchor.constraint(equalToConstant: 44), close.widthAnchor.constraint(greaterThanOrEqualToConstant: 64),
            web.topAnchor.constraint(equalTo: close.bottomAnchor), web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor), web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
    }
    @objc private func closePressed() { onClose() }
}
