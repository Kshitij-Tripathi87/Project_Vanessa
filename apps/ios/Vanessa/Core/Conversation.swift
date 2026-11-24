import Foundation

// Mirrors the value-state conversation reducer in packages/protocol. This is
// not a wire decoder: no remote event or cross-device sync is enabled here.
let conversationProtocolVersion = 1
let maximumConversationTurns = 200
let maximumTurnContent = 4_000 // UTF-16 code units, as in the shared contract
let maximumTranscriptChunk = 512

enum ConversationStatus: String, Codable { case active, paused, closed }
enum ConversationRole: String, Codable { case user, assistant }
enum ConversationSource: String, Codable { case text, voice }
enum ConversationTurnStatus: String, Codable {
    case received, processing, responding, completed, interrupted, failed
    var isTerminal: Bool { self == .completed || self == .interrupted || self == .failed }
}
enum ConversationInterruptReason: String, Codable { case bargeIn = "barge_in", userCancel = "user_cancel" }
enum ConversationEventType: String, Codable {
    case received = "turn.received"
    case transcriptPartial = "transcript.partial"
    case transcriptFinal = "transcript.final"
    case responseChunk = "response.chunk"
    case responseCompleted = "response.completed"
    case interrupted = "turn.interrupted"
    case failed = "turn.failed"
}

struct ConversationTurn: Codable, Equatable, Identifiable {
    var id: String { turnId }
    let turnId: String
    let conversationId: String
    let requestId: String
    let role: ConversationRole
    let source: ConversationSource
    var text: String
    var isFinal: Bool
    var streaming: Bool
    var status: ConversationTurnStatus
    let createdAt: Int64
    var interruptReason: ConversationInterruptReason?

    enum CodingKeys: String, CodingKey {
        case turnId, conversationId, requestId, role, source, text
        case isFinal = "final"
        case streaming, status, createdAt, interruptReason
    }
}

/// Used only for internally generated events and checked-in reducer fixtures.
/// This is intentionally not exposed as a network or untrusted JSON codec.
struct ConversationEvent: Codable {
    let conversationId: String
    let turnId: String
    let type: ConversationEventType
    var requestId: String? = nil
    var role: ConversationRole? = nil
    var source: ConversationSource? = nil
    var createdAt: Int64? = nil
    var text: String? = nil
    var reason: String? = nil
}

struct ConversationState: Codable, Equatable {
    let conversationId: String
    var status: ConversationStatus
    var turns: [ConversationTurn]
    var activeTurnId: String?

    static func initial(_ id: String) -> ConversationState {
        ConversationState(conversationId: id, status: .active, turns: [], activeTurnId: nil)
    }

    /// The Boolean distinguishes an ignored event from an accepted event whose
    /// value happens to equal the previous value (Swift structs have value semantics).
    func applying(_ event: ConversationEvent) -> (state: ConversationState, changed: Bool) {
        guard event.conversationId == conversationId else { return (self, false) }
        let index = turns.firstIndex { $0.turnId == event.turnId }
        if event.type == .received {
            guard index == nil, let requestId = event.requestId, let role = event.role,
                  let source = event.source, let createdAt = event.createdAt else { return (self, false) }
            var next = self
            next.turns.append(ConversationTurn(
                turnId: event.turnId, conversationId: conversationId, requestId: requestId,
                role: role, source: source, text: "", isFinal: false, streaming: false,
                status: .received, createdAt: createdAt, interruptReason: nil
            ))
            if next.turns.count > maximumConversationTurns {
                next.turns.removeFirst(next.turns.count - maximumConversationTurns)
            }
            next.recomputeActiveTurn()
            return (next, true)
        }
        guard let index, !turns[index].status.isTerminal else { return (self, false) }
        var next = self
        var turn = next.turns[index]
        switch event.type {
        case .received:
            return (self, false)
        case .transcriptPartial:
            guard !turn.isFinal, turn.status == .received || turn.status == .processing,
                  let text = event.text, !text.isEmpty else { return (self, false) }
            turn.text = text
        case .transcriptFinal:
            guard !turn.isFinal, let text = event.text else { return (self, false) }
            turn.text = text
            turn.isFinal = true
            turn.status = turn.role == .user ? .completed : .processing
        case .responseChunk:
            guard turn.role == .assistant,
                  turn.status == .received || turn.status == .processing || turn.status == .responding,
                  let text = event.text, !text.isEmpty else { return (self, false) }
            let combined = turn.streaming ? turn.text + text : text
            if combined.utf16.count > maximumTurnContent {
                turn.status = .failed
                turn.isFinal = true
            } else {
                turn.text = combined
                turn.status = .responding
                turn.streaming = true
            }
        case .responseCompleted:
            guard turn.status == .processing || turn.status == .responding else { return (self, false) }
            turn.status = .completed
            turn.isFinal = true
        case .interrupted:
            guard let reason = event.reason.flatMap(ConversationInterruptReason.init(rawValue:)) else { return (self, false) }
            turn.status = .interrupted
            turn.interruptReason = reason
            turn.isFinal = true
        case .failed:
            guard let reason = event.reason else { return (self, false) }
            turn.status = .failed
            if turn.text.isEmpty { turn.text = reason }
            turn.isFinal = true
        }
        next.turns[index] = turn
        next.recomputeActiveTurn()
        return (next, true)
    }

    private mutating func recomputeActiveTurn() {
        activeTurnId = turns.last { !$0.status.isTerminal }?.turnId
    }

    /// Only terminal turns are persisted. Failed/interrupted partials are not.
    func persistedProjection() -> ConversationState {
        var result = self
        result.turns = turns.filter { $0.status.isTerminal }.map { turn in
            var saved = turn
            if saved.status != .completed {
                saved.text = ""
                saved.streaming = false
            }
            return saved
        }
        result.activeTurnId = nil
        return result
    }

    /// Reject corrupt or incompatible local snapshots, rather than replaying them.
    func isValidPersistedProjection() -> Bool {
        func canonicalUUID(_ value: String) -> Bool {
            guard let uuid = UUID(uuidString: value) else { return false }
            return uuid.uuidString.lowercased() == value
        }
        guard canonicalUUID(conversationId), activeTurnId == nil, turns.count <= maximumConversationTurns else { return false }
        var turnIds = Set<String>()
        var requestRoles = Set<String>()
        for turn in turns {
            guard canonicalUUID(turn.turnId), canonicalUUID(turn.requestId), turn.conversationId == conversationId,
                  turn.createdAt >= 0, turn.createdAt <= 8_640_000_000_000_000,
                  turn.isFinal, turn.status.isTerminal, turn.text.utf16.count <= maximumTurnContent,
                  turnIds.insert(turn.turnId).inserted,
                  requestRoles.insert("\(turn.requestId):\(turn.role.rawValue)").inserted else { return false }
            if turn.status == .completed {
                if turn.text.isEmpty { return false }
            } else if !turn.text.isEmpty || turn.streaming {
                return false
            }
        }
        return true
    }
}
