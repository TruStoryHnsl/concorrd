// JSBridge.swift
// Concord tvOS — bridge protocol and real implementation.
//
// Defines the 4-function bridge interface between the tvOS SwiftUI
// shell and the Concord server API. Since WebKit is unavailable on
// tvOS, this protocol is implemented as direct native calls
// (UserDefaults for persistence, AuthenticationServices for OAuth).
//
// The TypeScript side (`client/src/api/tvOSHost.ts`) retains the
// same 4-function contract — only the transport changes from
// postMessage to native Swift calls on tvOS.
//
// Reference: docs/native-apps/appletv-feasibility.md §4 (Path C)

import Foundation
import AuthenticationServices

// MARK: - Bridge Protocol

/// The 4-function bridge contract between the tvOS native shell and
/// the Concord server.
///
/// On tvOS this is implemented as direct native calls (not postMessage),
/// since WebKit.framework is unavailable on tvOS.
protocol ConcordBridgeProtocol: AnyObject {
    /// Persist the server configuration to UserDefaults.
    ///
    /// Called when the user selects or configures a homeserver in the
    /// server picker. The config is a dictionary with at minimum a
    /// `homeserverUrl` key.
    ///
    /// - Parameter config: Server configuration dictionary.
    func setServerConfig(_ config: [String: Any])

    /// Load the stored server configuration from UserDefaults.
    ///
    /// - Returns: The stored config dictionary, or nil if none is saved.
    func getServerConfig() -> [String: Any]?

    /// Notify the native layer that focus has moved to a new element.
    ///
    /// Used to keep the tvOS UIFocus system in sync with the SwiftUI
    /// navigation state.
    ///
    /// - Parameter elementId: Identifier of the newly focused element.
    func focusChanged(elementId: String)

    /// Open an authentication URL via ASWebAuthenticationSession.
    ///
    /// Delegates OAuth/OIDC flows to the system auth session handler.
    ///
    /// - Parameter url: The full authentication URL to open.
    func openAuthURL(_ url: String)
}

// MARK: - UserDefaults key

private let kServerConfigKey = "com.concord.serverConfig"

// MARK: - Real Implementation

/// Production implementation of the bridge protocol.
///
/// - `setServerConfig` / `getServerConfig`: persist to and read from
///   UserDefaults as a JSON-encoded Data blob under the key
///   `com.concord.serverConfig`. Dictionary values must be
///   PropertyList-serializable (strings, numbers, bools, nested dicts/arrays).
///
/// - `openAuthURL`: opens an ASWebAuthenticationSession for OAuth flows.
///   On tvOS the session presents a system UI that shows the URL and
///   a one-time code for the user to complete auth on another device.
///
/// - `focusChanged`: logs the element ID. Real UIFocus bridging is
///   deferred until the native channel list UI is implemented — at that
///   point, focusChanged will programmatically move UIFocus to the
///   corresponding SwiftUI view.
final class ConcordJSBridge: NSObject, ConcordBridgeProtocol {

    private let defaults = UserDefaults.standard

    // MARK: - Server Config Persistence

    func setServerConfig(_ config: [String: Any]) {
        do {
            let data = try JSONSerialization.data(withJSONObject: config, options: [])
            defaults.set(data, forKey: kServerConfigKey)
            defaults.synchronize()
            print("[ConcordBridge] setServerConfig: saved \(config["homeserverUrl"] ?? "unknown")")
        } catch {
            print("[ConcordBridge] setServerConfig: failed to serialize — \(error.localizedDescription)")
        }
    }

    func getServerConfig() -> [String: Any]? {
        guard let data = defaults.data(forKey: kServerConfigKey) else {
            print("[ConcordBridge] getServerConfig: no stored config")
            return nil
        }
        do {
            let config = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
            print("[ConcordBridge] getServerConfig: loaded \(config?["homeserverUrl"] ?? "unknown")")
            return config
        } catch {
            print("[ConcordBridge] getServerConfig: failed to deserialize — \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Focus Bridging

    func focusChanged(elementId: String) {
        // TODO: When the native SwiftUI channel list is implemented,
        // this should programmatically update the UIFocus engine to
        // move focus to the corresponding SwiftUI view identified by
        // elementId. For now, log for debugging.
        print("[ConcordBridge] focusChanged: \(elementId)")
    }

    // MARK: - OAuth Authentication

    func openAuthURL(_ url: String) {
        guard let authURL = URL(string: url) else {
            print("[ConcordBridge] openAuthURL: invalid URL — \(url)")
            return
        }

        // ASWebAuthenticationSession is available on tvOS 16.0+.
        // It presents a system-managed auth flow where the user
        // completes login on a companion device (phone/computer)
        // using a displayed code.
        let session = ASWebAuthenticationSession(
            url: authURL,
            callbackURLScheme: "concord"
        ) { callbackURL, error in
            if let error = error {
                print("[ConcordBridge] openAuthURL: auth error — \(error.localizedDescription)")
                return
            }
            if let callbackURL = callbackURL {
                print("[ConcordBridge] openAuthURL: auth callback — \(callbackURL)")
                // TODO: Extract token from callback URL and pass to
                // the server config store. This will be wired when the
                // login flow is fully implemented.
            }
        }

        // Avoid persisting cookies from the auth flow into browser state.
        // prefersEphemeralWebBrowserSession is unavailable on tvOS —
        // Apple TV has no persistent browser state, so this is moot.
        #if !os(tvOS)
        session.prefersEphemeralWebBrowserSession = true
        #endif
        session.start()
    }
}
