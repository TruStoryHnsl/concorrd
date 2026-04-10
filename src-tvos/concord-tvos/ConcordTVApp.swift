// ConcordTVApp.swift — tvOS application entry point.
//
// This is the SwiftUI @main app struct for the Concord tvOS client.
// It hosts a single full-screen WKWebView that loads the same
// client/dist bundle used by the iOS, desktop, and web builds.
//
// No Tauri dependency. No Rust runtime. The only bridge between
// Swift and JavaScript is the 4-function JSBridge (see JSBridge.swift).

import SwiftUI

@main
struct ConcordTVApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .ignoresSafeArea()
        }
    }
}
