import Foundation
import XCTest
@testable import VanessaCore

final class ConversationTests: XCTestCase {
    func testSharedReducerFixtureAfterEveryEvent() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../packages/protocol/fixtures/conversation-reducer-vectors-v1.json")
        XCTAssertEqual(try checkSharedReducerFixture(Data(contentsOf: fixture)), 64)
    }

    func testPersistenceDropsLiveAndIncompleteContentAndRejectsInvalidSnapshot() {
        let id = "11111111-1111-4111-8111-111111111111"
        let user = ConversationTurn(turnId: "22222222-2222-4222-8222-222222222222", conversationId: id,
                                    requestId: "33333333-3333-4333-8333-333333333333", role: .user, source: .voice,
                                    text: "Done", isFinal: true, streaming: false, status: .completed,
                                    createdAt: 0, interruptReason: nil)
        let draft = ConversationTurn(turnId: "44444444-4444-4444-8444-444444444444", conversationId: id,
                                     requestId: user.requestId, role: .assistant, source: .voice,
                                     text: "partial response", isFinal: true, streaming: true, status: .failed,
                                     createdAt: 1, interruptReason: nil)
        let pending = ConversationTurn(turnId: "55555555-5555-4555-8555-555555555555", conversationId: id,
                                       requestId: "66666666-6666-4666-8666-666666666666", role: .user, source: .voice,
                                       text: "unfinished", isFinal: false, streaming: false, status: .received,
                                       createdAt: 2, interruptReason: nil)
        let state = ConversationState(conversationId: id, status: .active, turns: [user, draft, pending], activeTurnId: pending.turnId)
        let saved = state.persistedProjection()
        XCTAssertEqual(saved.turns.count, 2)
        XCTAssertEqual(saved.turns[1].text, "")
        XCTAssertFalse(saved.turns[1].streaming)
        XCTAssertNil(saved.activeTurnId)
        XCTAssertTrue(saved.isValidPersistedProjection())
        var invalid = saved
        invalid.turns.append(user)
        XCTAssertFalse(invalid.isValidPersistedProjection())
    }

    func testUtf16BoundIsNotGraphemeCount() {
        let tooLong = String(repeating: "😀", count: 2_001)
        XCTAssertEqual(tooLong.utf16.count, 4_002)
        XCTAssertGreaterThan(tooLong.utf16.count, maximumTurnContent)
    }
}
