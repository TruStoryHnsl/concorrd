// ContentView.swift — Root SwiftUI view for the tvOS app.
//
// Hosts the FocusableWebView which wraps WKWebView with the tvOS
// focus engine bridge. Displays a loading indicator while the web
// bundle initialises and an error view if the bundle is missing.

import SwiftUI

struct ContentView: View {
    @State private var isLoading = true
    @State private var loadError: String? = nil

    var body: some View {
        ZStack {
            // Dark background matching the Concord design system.
            Color(red: 0.047, green: 0.055, blue: 0.067) // #0c0e11
                .ignoresSafeArea()

            if let error = loadError {
                VStack(spacing: 20) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 64))
                        .foregroundColor(.yellow)
                    Text("Failed to load Concord")
                        .font(.title)
                        .foregroundColor(.white)
                    Text(error)
                        .font(.body)
                        .foregroundColor(.gray)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 60)
                }
            } else {
                FocusableWebView(
                    isLoading: $isLoading,
                    loadError: $loadError
                )
                .ignoresSafeArea()

                if isLoading {
                    ProgressView()
                        .progressViewStyle(.automatic)
                        .scaleEffect(1.5)
                }
            }
        }
    }
}
