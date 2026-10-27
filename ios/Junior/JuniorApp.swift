import SwiftUI
import UIKit

@main
struct JuniorApp: App {
    init() {
        // Brand fonts and the ink canvas on the system bars.
        let nav = UINavigationBarAppearance()
        nav.configureWithOpaqueBackground()
        nav.backgroundColor = UIColor(Theme.canvas)
        nav.shadowColor = UIColor(Theme.hair)
        nav.titleTextAttributes = [.foregroundColor: UIColor(Theme.ink), .font: UIFont(name: "Geist-Regular", size: 17) ?? .systemFont(ofSize: 17)]
        nav.largeTitleTextAttributes = [.foregroundColor: UIColor(Theme.ink), .font: UIFont(name: "InstrumentSerif-Regular", size: 36) ?? .systemFont(ofSize: 34)]
        UINavigationBar.appearance().standardAppearance = nav
        UINavigationBar.appearance().scrollEdgeAppearance = nav
        UINavigationBar.appearance().compactAppearance = nav

        let tab = UITabBarAppearance()
        tab.configureWithOpaqueBackground()
        tab.backgroundColor = UIColor(Theme.canvas)
        tab.shadowColor = UIColor(Theme.hair)
        UITabBar.appearance().standardAppearance = tab
        UITabBar.appearance().scrollEdgeAppearance = tab
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.dark)
                .tint(Theme.ink)
        }
    }
}
