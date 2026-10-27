import SwiftUI
import UIKit

/// The first screen: scan the QR code on the Mac, or paste its link.
struct PairView: View {
    var notice: String?
    var onLink: (URL) -> Void

    @State private var error: String?
    @State private var pasting = false
    @State private var pasted = ""

    var body: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 0)
            Text("Pair with your Mac")
                .font(.system(size: 26, weight: .semibold))
                .foregroundColor(.white)
            Text("On your Mac, click the phone icon in Junior’s top bar, switch it on, and scan the QR code.")
                .font(.system(size: 15))
                .foregroundColor(Color(white: 0.62))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)

            ScannerView { accept($0) }
                .frame(width: 280, height: 280)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.white.opacity(0.14), lineWidth: 1))

            if let message = error ?? notice {
                Text(message)
                    .font(.system(size: 14))
                    .foregroundColor(Color(red: 1, green: 0.62, blue: 0.4))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
            }

            if pasting {
                HStack(spacing: 8) {
                    TextField("Paste the pairing link", text: $pasted)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .padding(10)
                        .background(Color.white.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .foregroundColor(.white)
                        .onSubmit { accept(pasted) }
                    Button("Pair") { accept(pasted) }
                        .buttonStyle(.borderedProminent)
                }
                .padding(.horizontal, 24)
            } else {
                Button("Paste a link instead") { pasting = true }
                    .font(.system(size: 15))
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color("Canvas"))
    }

    private func accept(_ text: String) {
        if let url = Pairing.parse(text) {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onLink(url)
        } else {
            error = "That is not a Junior pairing code. Use the QR code in Junior’s phone popover."
        }
    }
}
