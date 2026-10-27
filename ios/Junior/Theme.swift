import SwiftUI

/// Brand v2 (.docs/design.md): warm ink canvas, paper text, orange only for "needs you".
enum Theme {
    static let canvas = Color(hex: 0x0C0B0A)
    static let elev = Color(hex: 0x1B1917)
    static let deep = Color(hex: 0x090807)
    static let ink = Color(hex: 0xF8F7F4)
    static let body = Color(hex: 0xF8F7F4).opacity(0.86)
    static let mute = Color(hex: 0xA8A49D)
    static let ash = Color(hex: 0x8D8982)
    static let stone = Color(hex: 0x4B4843)
    static let hair = Color(hex: 0xF8F7F4).opacity(0.07)
    static let hairStrong = Color(hex: 0xF8F7F4).opacity(0.13)
    static let orange = Color(hex: 0xFF6A1F)
    static let green = Color(hex: 0x11FF99)
    static let blue = Color(hex: 0x80B2F6)
    static let red = Color(hex: 0xFF2047)
    static let yellow = Color(hex: 0xFFC53D)

    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .custom("Geist", size: size).weight(weight) }
    static func mono(_ size: CGFloat) -> Font { .custom("Geist Mono", size: size) }
    static func serif(_ size: CGFloat) -> Font { .custom("Instrument Serif", size: size) }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }

    /// `#rrggbb` as the workspace colours come, else the brand blue.
    init(css: String) {
        let s = css.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        if s.count == 6, let v = UInt32(s, radix: 16) { self.init(hex: v) } else { self = Theme.blue }
    }
}

extension Date {
    /// "now", "5m", "3h", "2d", like the web list.
    var ago: String {
        let s = max(0, -timeIntervalSinceNow)
        if s < 60 { return "now" }
        if s < 3600 { return "\(Int(s / 60))m" }
        if s < 86400 { return "\(Int(s / 3600))h" }
        return "\(Int(s / 86400))d"
    }
}
