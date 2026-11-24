import Foundation
#if SWIFT_PACKAGE
@testable import VanessaCore
#endif

private struct FixtureDocument: Decodable { let version: Int; let vectors: [FixtureVector] }
private struct FixtureVector: Decodable {
    let name: String
    let conversationId: String
    let initialState: ConversationState?
    let steps: [FixtureStep]
}
private struct FixtureStep: Decodable {
    let event: ConversationEvent
    let same: Bool
    let state: ConversationState
}
struct FixtureFailure: Error, CustomStringConvertible {
    let description: String
}

/// Reuses the checked-in TypeScript/Android fixture without duplicating it.
func checkSharedReducerFixture(_ data: Data) throws -> Int {
    let document = try JSONDecoder().decode(FixtureDocument.self, from: data)
    guard document.version == conversationProtocolVersion, document.vectors.count >= 10 else {
        throw FixtureFailure(description: "Unexpected conversation fixture version or count")
    }
    var count = 0
    for vector in document.vectors {
        var state = vector.initialState ?? .initial(vector.conversationId)
        for (index, step) in vector.steps.enumerated() {
            let result = state.applying(step.event)
            guard result.changed == !step.same, result.state == step.state else {
                throw FixtureFailure(description: "Reducer mismatch: \(vector.name), step \(index)")
            }
            state = result.state
            count += 1
        }
    }
    return count
}
