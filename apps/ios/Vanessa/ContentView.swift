import SwiftUI

struct ContentView: View {
    @StateObject private var model = ConversationViewModel()
    @StateObject private var speech = OnDeviceSpeechInput()
    @Environment(\.scenePhase) private var scenePhase
    @State private var confirmClear = false
    private let accent = Color(red: 0.1, green: 0.85, blue: 0.95)

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                statusCard
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if model.conversation.turns.isEmpty {
                                VStack(spacing: 12) {
                                    Image(systemName: "waveform.circle.fill")
                                        .font(.system(size: 66)).foregroundStyle(accent)
                                    Text("How can I help?").font(.title2.weight(.semibold))
                                    Text("Conversation stays on this device. Voice transcripts are reviewed before sending.")
                                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                                }.frame(maxWidth: .infinity).padding(.top, 48)
                            }
                            ForEach(model.conversation.turns) { turn in
                                turnView(turn).id(turn.turnId)
                            }
                        }.padding()
                    }
                    .onChange(of: model.conversation.turns.count) { _ in
                        if let id = model.conversation.turns.last?.turnId { proxy.scrollTo(id, anchor: .bottom) }
                    }
                }
                composer
            }
            .background(Color(red: 0.025, green: 0.04, blue: 0.07))
            .foregroundStyle(.white)
            .navigationTitle("Vanessa")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Clear", role: .destructive) { confirmClear = true }
                        .disabled(model.isResponding || speech.isBusy || model.conversation.turns.isEmpty)
                }
            }
            .confirmationDialog("Clear local conversation?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Clear this device's history", role: .destructive) { model.clearHistory() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This removes this app's current history file. Backups and device remnants may remain.")
            }
            .onChange(of: scenePhase) { phase in
                if phase == .active { model.refreshModelAvailability() }
                else { speech.cancel() }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(model.modelAvailable ? "Local model ready" : "Local model unavailable", systemImage: model.modelAvailable ? "checkmark.shield" : "exclamationmark.triangle")
                .font(.subheadline.weight(.semibold)).foregroundStyle(model.modelAvailable ? accent : .orange)
            Text(model.modelStatus).font(.caption).foregroundStyle(.secondary)
            Text(model.historyStatus).font(.caption2).foregroundStyle(.secondary)
            Text("PC control, sync, and spoken answers are not available in this client yet.")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 12))
        .padding([.horizontal, .top])
    }

    private func turnView(_ turn: ConversationTurn) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(turn.role == .user ? "You" : "Vanessa")
                .font(.caption.weight(.semibold)).foregroundStyle(accent)
            Text(displayText(turn)).font(.body).textSelection(.enabled)
            if turn.status == .failed || turn.status == .interrupted {
                Text(turn.status == .failed ? "Response not completed" : "Turn interrupted")
                    .font(.caption2).foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.white.opacity(turn.role == .user ? 0.08 : 0.04), in: RoundedRectangle(cornerRadius: 14))
    }

    private func displayText(_ turn: ConversationTurn) -> String {
        if !turn.text.isEmpty { return turn.text }
        if !turn.status.isTerminal { return "Thinking on this device…" }
        return "No completed text was saved for this turn."
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !speech.partial.isEmpty {
                Text(speech.partial).font(.caption).foregroundStyle(accent)
                    .accessibilityLabel("Voice draft: \(speech.partial)")
            }
            Text(speech.status).font(.caption2).foregroundStyle(.secondary)
            if !model.notice.isEmpty { Text(model.notice).font(.caption).foregroundStyle(.orange) }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Type a message…", text: Binding(get: { model.draft }, set: { model.editDraft($0) }), axis: .vertical)
                    .lineLimit(1...4)
                    .padding(10)
                    .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    .disabled(model.isResponding || speech.isRecording || speech.isFinalizing)
                Button {
                    if speech.isRecording {
                        speech.finish()
                    } else {
                        Task { await speech.start { transcript in model.useTranscript(transcript) } }
                    }
                } label: {
                    Image(systemName: speech.isRecording ? "stop.fill" : "mic.fill")
                        .frame(width: 42, height: 42).background(accent.opacity(0.2), in: Circle())
                }
                .accessibilityLabel(speech.isRecording ? "Finish voice input" : "Start on-device voice input")
                .disabled(model.isResponding || (speech.isBusy && !speech.isRecording) || scenePhase != .active)
                Button("Send") { model.send() }
                    .buttonStyle(.borderedProminent).tint(accent).foregroundStyle(.black)
                    .disabled(model.isResponding || speech.isBusy || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if speech.isBusy {
                Button("Cancel voice input") { speech.cancel() }.font(.caption)
            }
        }
        .padding()
        .background(Color.black.opacity(0.25))
    }
}
