// FocusableWebView.swift — tvOS focus-engine bridge for WKWebView.
//
// tvOS has no touchscreen. All navigation uses the Siri Remote which
// emits DPAD events through the UIFocusSystem. WKWebView on tvOS does
// NOT automatically bridge the UIFocus engine into DOM focus events,
// so we need to:
//
//   1. Wrap the WKWebView in a UIKit container that participates in
//      the UIFocus system.
//   2. Intercept Siri Remote press events (DPAD arrows, select, menu,
//      play/pause).
//   3. Translate them into DOM KeyboardEvent dispatches via
//      evaluateJavaScript, matching the key names that the existing
//      useDpadNav.ts hook already handles.
//
// Key mapping:
//   Siri Remote DPAD Up    -> ArrowUp
//   Siri Remote DPAD Down  -> ArrowDown
//   Siri Remote DPAD Left  -> ArrowLeft
//   Siri Remote DPAD Right -> ArrowRight
//   Siri Remote Select     -> Enter
//   Siri Remote Menu       -> Escape
//   Siri Remote Play/Pause -> MediaPlayPause

import SwiftUI
import WebKit

/// SwiftUI wrapper that hosts the WKWebView with focus-engine bridging.
struct FocusableWebView: UIViewRepresentable {
    @Binding var isLoading: Bool
    @Binding var loadError: String?

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> FocusableWebViewContainer {
        let bridge = JSBridge()
        let webView = WebViewFactory.makeWebView(bridge: bridge)
        bridge.webView = webView
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView

        let container = FocusableWebViewContainer(webView: webView)

        if let error = WebViewFactory.loadBundle(into: webView) {
            DispatchQueue.main.async {
                self.loadError = error
            }
        }

        return container
    }

    func updateUIView(_ uiView: FocusableWebViewContainer, context: Context) {
        // No dynamic updates needed — the webview manages its own state.
    }

    // MARK: - Coordinator (navigation delegate)

    final class Coordinator: NSObject, WKNavigationDelegate {
        let parent: FocusableWebView
        weak var webView: WKWebView?

        init(parent: FocusableWebView) {
            self.parent = parent
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            DispatchQueue.main.async {
                self.parent.isLoading = false
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            DispatchQueue.main.async {
                self.parent.isLoading = false
                self.parent.loadError = error.localizedDescription
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            DispatchQueue.main.async {
                self.parent.isLoading = false
                self.parent.loadError = error.localizedDescription
            }
        }
    }
}

// MARK: - FocusableWebViewContainer

/// UIKit container that wraps WKWebView and bridges tvOS focus/press
/// events into DOM KeyboardEvents.
final class FocusableWebViewContainer: UIView {

    let webView: WKWebView

    init(webView: WKWebView) {
        self.webView = webView
        super.init(frame: .zero)
        addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])

        // Register press gesture recognisers for the Siri Remote.
        registerPressRecognisers()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    // MARK: - Focus

    override var canBecomeFocused: Bool { true }

    override func didUpdateFocus(
        in context: UIFocusUpdateContext,
        with coordinator: UIFocusAnimationCoordinator
    ) {
        super.didUpdateFocus(in: context, with: coordinator)
        // Ensure the container stays focused so press events route here.
    }

    // MARK: - Press events (Siri Remote)

    private func registerPressRecognisers() {
        let pressTypes: [(UIPress.PressType, String)] = [
            (.upArrow,    "ArrowUp"),
            (.downArrow,  "ArrowDown"),
            (.leftArrow,  "ArrowLeft"),
            (.rightArrow, "ArrowRight"),
            (.select,     "Enter"),
            (.menu,       "Escape"),
            (.playPause,  "MediaPlayPause"),
        ]

        for (pressType, _) in pressTypes {
            let tap = UITapGestureRecognizer(
                target: self,
                action: #selector(handleTap(_:))
            )
            tap.allowedPressTypes = [NSNumber(value: pressType.rawValue)]
            addGestureRecognizer(tap)
        }
    }

    @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
        guard let pressType = recognizer.allowedPressTypes.first?.intValue,
              let uiPressType = UIPress.PressType(rawValue: pressType) else {
            return
        }

        let keyName: String
        switch uiPressType {
        case .upArrow:    keyName = "ArrowUp"
        case .downArrow:  keyName = "ArrowDown"
        case .leftArrow:  keyName = "ArrowLeft"
        case .rightArrow: keyName = "ArrowRight"
        case .select:     keyName = "Enter"
        case .menu:       keyName = "Escape"
        case .playPause:  keyName = "MediaPlayPause"
        default:          return
        }

        dispatchKeyEvent(key: keyName)
    }

    /// Dispatch a DOM KeyboardEvent into the WKWebView. The event
    /// shape matches what useDpadNav.ts expects: a 'keydown' event
    /// with `event.key` set to the standard key name.
    private func dispatchKeyEvent(key: String) {
        let js = """
        (function() {
            var event = new KeyboardEvent('keydown', {
                key: '\(key)',
                code: '\(key)',
                bubbles: true,
                cancelable: true
            });
            document.dispatchEvent(event);
        })();
        """
        webView.evaluateJavaScript(js)
    }
}
