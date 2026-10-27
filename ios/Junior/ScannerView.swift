import AVFoundation
import SwiftUI
import UIKit

/// A camera view that reads QR codes and hands each one's text to `onCode`.
struct ScannerView: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {
        controller.onCode = onCode
    }
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var lastText = ""
    private var lastAt = Date.distantPast

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            start()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] ok in
                DispatchQueue.main.async {
                    if ok {
                        self?.start()
                    } else {
                        self?.say("Camera access is off. Allow it in Settings → Junior, or paste the link instead.")
                    }
                }
            }
        default:
            say("Camera access is off. Allow it in Settings → Junior, or paste the link instead.")
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning { session.stopRunning() }
    }

    private func start() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else { return say("No camera here. Paste the link instead.") }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return say("The camera would not start. Paste the link instead.") }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        preview = layer
        DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
    }

    private func say(_ text: String) {
        let label = UILabel()
        label.text = text
        label.textColor = UIColor(white: 0.7, alpha: 1)
        label.font = .systemFont(ofSize: 14)
        label.numberOfLines = 0
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
        ])
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let code = objects.first as? AVMetadataMachineReadableCodeObject, let text = code.stringValue else { return }
        // The camera sees the same code many times a second; say each once, then again after a pause.
        if text == lastText, Date().timeIntervalSince(lastAt) < 2 { return }
        lastText = text
        lastAt = Date()
        onCode?(text)
    }
}
