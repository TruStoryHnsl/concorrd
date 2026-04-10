// JSBridge.swift — 4-function JavaScript bridge for the tvOS shell.
//
// Exposes four message handlers to the WKWebView's JavaScript context:
//
//   1. concordSetServerConfig — persist server config to UserDefaults
//   2. concordGetServerConfig — load from UserDefaults (writes to
//      localStorage for synchronous JS access)
//   3. concordFocusChanged    — (reserved) Swift->JS focus bridge
//   4. concordOpenAuthURL     — delegate to ASWebAuthenticationSession
//
// The bridge is registered on a WKUserContentController via
// `register(on:)` and the injected host-setup.js (in
// WebViewContainer.swift) wraps these into the
// `window.concordTVHost` namespace that tvOSHost.ts consumes.

import WebKit
import AuthenticationServices

/// The 4-function JS bridge between the tvOS SwiftUI shell and the
/// Concord React client running inside WKWebView.
final class JSBridge: NSObject, WKScriptMessageHandler {

    // MARK: - Storage keys

    private static let serverConfigKey = "com.concord.chat.tv.serverConfig"

    // MARK: - State

    /// Weak ref to the webview — needed for evaluateJavaScript calls
    /// (e.g. writing getServerConfig results back to localStorage).
    weak var webView: WKWebView?

    // MARK: - Registration

    /// Register all four message handlers on the given content controller.
    func register(on controller: WKUserContentController) {
        controller.add(self, name: "concordSetServerConfig")
        controller.add(self, name: "concordGetServerConfig")
        controller.add(self, name: "concordFocusChanged")
        controller.add(self, name: "concordOpenAuthURL")
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        switch message.name {
        case "concordSetServerConfig":
            handleSetServerConfig(message.body)
        case "concordGetServerConfig":
            handleGetServerConfig()
        case "concordFocusChanged":
            // Reserved: Swift->JS direction. The JS side calls
            // window.concordTVHost.focusChanged() directly via
            // the injected focus-bridge script. This handler
            // exists for future Swift-initiated focus updates.
            break
        case "concordOpenAuthURL":
            handleOpenAuthURL(message.body)
        default:
            break
        }
    }

    // MARK: - Handler implementations

    private func handleSetServerConfig(_ body: Any) {
        guard let json = body as? String else { return }
        UserDefaults.standard.set(json, forKey: Self.serverConfigKey)

        // Also write to localStorage so getServerConfig() (synchronous
        // JS call) can read it without another round-trip.
        let escaped = json
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        webView?.evaluateJavaScript(
            "try { localStorage.setItem('__concordTVHost_serverConfig', '\(escaped)'); } catch(e) {}"
        )
    }

    private func handleGetServerConfig() {
        guard let json = UserDefaults.standard.string(forKey: Self.serverConfigKey) else {
            // Write null to localStorage.
            webView?.evaluateJavaScript(
                "try { localStorage.removeItem('__concordTVHost_serverConfig'); } catch(e) {}"
            )
            return
        }
        let escaped = json
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        webView?.evaluateJavaScript(
            "try { localStorage.setItem('__concordTVHost_serverConfig', '\(escaped)'); } catch(e) {}"
        )
    }

    private func handleOpenAuthURL(_ body: Any) {
        guard let urlString = body as? String,
              let url = URL(string: urlString) else { return }

        // ASWebAuthenticationSession handles the OAuth flow in a
        // system-provided web view and returns the callback URL.
        let session = ASWebAuthenticationSession(
            url: url,
            callbackURLScheme: "concord"
        ) { [weak self] callbackURL, error in
            if let error = error {
                print("[JSBridge] Auth session error: \(error.localizedDescription)")
                return
            }
            guard let callbackURL = callbackURL else { return }
            // Pass the callback URL back to the webview so the React
            // auth flow can process the OAuth response.
            let js = "window.dispatchEvent(new CustomEvent('concord-auth-callback', { detail: '\(callbackURL.absoluteString)' }));"
            self?.webView?.evaluateJavaScript(js)
        }

        // On tvOS, ASWebAuthenticationSession presents itself
        // automatically — no presentationContextProvider needed.
        session.prefersEphemeralWebBrowserSession = false
        session.start()
    }
}
