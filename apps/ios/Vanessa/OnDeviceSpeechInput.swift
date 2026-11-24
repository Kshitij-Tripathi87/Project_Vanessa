import AVFoundation
import Combine
import Foundation
import Speech
import UIKit

/// Foreground push-to-talk only. Recognition is refused unless Apple reports
/// an on-device recognizer and the request explicitly requires on-device work.
@MainActor
final class OnDeviceSpeechInput: ObservableObject {
    @Published private(set) var isPreparing = false
    @Published private(set) var isRecording = false
    @Published private(set) var isFinalizing = false
    @Published private(set) var partial = ""
    @Published private(set) var status = "Voice input uses an on-device recognizer when available."

    private var generation: UInt64 = 0
    private var permissionPending = false
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var onFinal: ((String) -> Void)?
    var isBusy: Bool { isPreparing || isRecording || isFinalizing || permissionPending }

    func start(onFinal: @escaping (String) -> Void) async {
        guard !isBusy, UIApplication.shared.applicationState == .active else { return }
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current),
              recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else {
            status = "On-device speech recognition is unavailable for this language or device. Type instead."
            return
        }
        generation &+= 1
        let token = generation
        permissionPending = true
        isPreparing = true
        status = "Checking microphone and speech permissions…"
        defer {
            permissionPending = false
            if generation == token { isPreparing = false }
        }
        let speechPermission: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard isCurrent(token), speechPermission == .authorized else {
            if isCurrent(token) { status = "Speech recognition permission was not granted. Type instead." }
            return
        }
        let microphonePermission: Bool = await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard isCurrent(token), microphonePermission else {
            if isCurrent(token) { status = "Microphone permission was not granted. Type instead." }
            return
        }
        guard recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else {
            status = "On-device speech recognition is no longer available. Type instead."
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true)
            let engine = AVAudioEngine()
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.requiresOnDeviceRecognition = true
            request.shouldReportPartialResults = true
            request.taskHint = .dictation
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { throw SpeechError.noInput }
            self.engine = engine
            self.request = request
            self.onFinal = onFinal
            partial = ""
            recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
                let text = result?.bestTranscription.formattedString
                let final = result?.isFinal == true
                let failed = error != nil
                Task { @MainActor [weak self] in self?.receive(text: text, final: final, failed: failed, token: token) }
            }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
            tapInstalled = true
            engine.prepare()
            try engine.start()
            isRecording = true
            status = "Listening on this device. Tap Finish when you are done."
        } catch {
            releaseCapture(cancelTask: true)
            status = "On-device speech could not start. Type instead."
        }
    }

    /// Asks for the last local transcript; it does not submit a task or message.
    func finish() {
        guard isRecording else { return }
        isRecording = false
        isFinalizing = true
        stopEngine()
        request?.endAudio()
        status = "Finishing the on-device transcript…"
        let token = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, self.generation == token, self.isFinalizing else { return }
            self.cancel()
            self.status = "Speech did not finish. Try again or type instead."
        }
    }

    /// Invalidates callbacks and pending permission results before teardown.
    func cancel() {
        generation &+= 1
        isPreparing = false
        releaseCapture(cancelTask: true)
        partial = ""
        status = "Voice input stopped. You can type your request."
    }

    private func isCurrent(_ token: UInt64) -> Bool {
        generation == token && UIApplication.shared.applicationState == .active
    }

    private func receive(text: String?, final: Bool, failed: Bool, token: UInt64) {
        guard isCurrent(token), isRecording || isFinalizing else { return }
        if let text { partial = text }
        if final {
            let transcript = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let callback = onFinal
            releaseCapture(cancelTask: true)
            partial = ""
            if transcript.isEmpty {
                status = "No speech was recognized. Try again or type instead."
            } else if transcript.utf16.count > maximumTurnContent {
                status = "The transcript is too long. Please shorten it."
            } else {
                status = "Transcript ready to review and send."
                callback?(transcript)
            }
        } else if failed {
            releaseCapture(cancelTask: true)
            status = "On-device recognition failed. Type instead."
        }
    }

    private func stopEngine() {
        engine?.stop()
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }
    }

    private func releaseCapture(cancelTask: Bool) {
        stopEngine()
        request?.endAudio()
        if cancelTask { recognitionTask?.cancel() }
        recognitionTask = nil
        request = nil
        engine = nil
        onFinal = nil
        isRecording = false
        isFinalizing = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private enum SpeechError: Error { case noInput }
}
