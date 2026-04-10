// WebViewContainer.swift — WKWebView setup and configuration.
//
// Creates and configures the WKWebView instance used by the tvOS
// app. Handles:
//   - Loading the bundled client/dist/index.html
//   - Registering the JSBridge message handlers
//   - Injecting the host-setup.js bootstrap script
//   - Configuring the Content Security Policy

import WebKit

/// Shared WKWebView factory. The returned webview has the JSBridge
/// message handlers registered and the host-setup.js injected.
enum WebViewFactory {

    /// Create a configured WKWebView ready to load the Concord bundle.
    static func makeWebView(bridge: JSBridge) -> WKWebView {
        let config = WKWebViewConfiguration()
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = prefs

        // Register the bridge message handlers.
        let contentController = WKUserContentController()
        bridge.register(on: contentController)

        // Inject the host-setup.js that creates window.concordTVHost.
        if let setupScript = Self.hostSetupScript() {
            let userScript = WKUserScript(
                source: setupScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            contentController.addUserScript(userScript)
        }

        config.userContentController = contentController

        // Allow inline media playback (needed for voice channel audio).
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = true

        return webView
    }

    /// Load the bundled client/dist/index.html into the webview.
    /// Returns an error string if the bundle is missing.
    @discardableResult
    static func loadBundle(into webView: WKWebView) -> String? {
        // The build script copies client/dist/ into Resources/dist/
        guard let distURL = Bundle.main.url(
            forResource: "index",
            withExtension: "html",
            subdirectory: "Resources/dist"
        ) else {
            // Fallback: try without the Resources/ prefix.
            guard let fallbackURL = Bundle.main.url(
                forResource: "index",
                withExtension: "html",
                subdirectory: "dist"
            ) else {
                return "Could not find client/dist/index.html in the app bundle. "
                     + "Run scripts/build_tvos_native.sh to build the client first."
            }
            let distDir = fallbackURL.deletingLastPathComponent()
            webView.loadFileURL(fallbackURL, allowingReadAccessTo: distDir)
            return nil
        }
        let distDir = distURL.deletingLastPathComponent()
        webView.loadFileURL(distURL, allowingReadAccessTo: distDir)
        return nil
    }

    // MARK: - Private

    /// Generate the JavaScript that creates window.concordTVHost.
    /// This runs at document-start so it is available before React mounts.
    private static func hostSetupScript() -> String? {
        return """
        (function() {
          'use strict';

          // The Swift-side JSBridge handles four message types:
          //   concordSetServerConfig, concordGetServerConfig,
          //   concordFocusChanged, concordOpenAuthURL
          //
          // This script creates the window.concordTVHost namespace that
          // client/src/api/tvOSHost.ts consumes.

          var callbacks = [];
          var pendingGetConfig = null;

          window.concordTVHost = {
            setServerConfig: function(json) {
              window.webkit.messageHandlers.concordSetServerConfig.postMessage(json);
            },

            getServerConfig: function() {
              // Synchronous bridge: the Swift side stores the result in
              // a cookie-style mechanism. For simplicity, we read from
              // localStorage where the bridge writes it.
              try {
                var raw = localStorage.getItem('__concordTVHost_serverConfig');
                return raw || null;
              } catch(e) {
                return null;
              }
            },

            focusChanged: function(elementId) {
              for (var i = 0; i < callbacks.length; i++) {
                try { callbacks[i](elementId); } catch(e) {}
              }
            },

            openAuthURL: function(url) {
              window.webkit.messageHandlers.concordOpenAuthURL.postMessage(url);
            },

            _focusCallbacks: callbacks
          };
        })();
        """
    }
}
