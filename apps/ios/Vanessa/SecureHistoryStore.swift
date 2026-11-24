import CryptoKit
import Foundation
import Security

/// One device-local encrypted snapshot. This is not sync or a task journal.
/// The AES key stays in the iOS Keychain and is unavailable while locked; the
/// ciphertext file is app-private, protected while locked and excluded from backup.
final class SecureHistoryStore {
    private struct Snapshot: Codable { let version: Int; let state: ConversationState }
    private let fileManager = FileManager.default
    private let service = "com.vanessa.ios.local-history.v1"
    private let account = "snapshot-key"
    private let aad = Data("vanessa.ios.local-history.v1".utf8)
    private let maximumBytes = 6 * 1_024 * 1_024
    private var directory: URL {
        get throws {
            guard let root = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
                throw HistoryError.unavailable
            }
            return root.appendingPathComponent("VanessaHistory", isDirectory: true)
        }
    }
    private var file: URL { get throws { try directory.appendingPathComponent("conversation.v1.enc") } }

    enum HistoryError: Error { case unavailable, invalid, keyUnavailable, storage }

    func load() throws -> ConversationState? {
        let file = try self.file
        guard fileManager.fileExists(atPath: file.path) else { return nil }
        let attributes = try fileManager.attributesOfItem(atPath: file.path)
        guard let size = attributes[.size] as? NSNumber, size.intValue > 0, size.intValue <= maximumBytes else {
            throw HistoryError.invalid
        }
        // Never generate a replacement key when ciphertext already exists.
        let key = try key(createIfMissing: false)
        let combined = try Data(contentsOf: file, options: .mappedIfSafe)
        let box = try AES.GCM.SealedBox(combined: combined)
        let plaintext = try AES.GCM.open(box, using: key, authenticating: aad)
        let snapshot = try JSONDecoder().decode(Snapshot.self, from: plaintext)
        guard snapshot.version == 1, snapshot.state.isValidPersistedProjection(), !snapshot.state.turns.isEmpty else {
            throw HistoryError.invalid
        }
        return snapshot.state
    }

    func save(_ state: ConversationState) throws {
        let snapshot = state.persistedProjection()
        guard snapshot.isValidPersistedProjection(), !snapshot.turns.isEmpty else { throw HistoryError.invalid }
        var directory = try self.directory
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true,
                                        attributes: [.protectionKey: FileProtectionType.complete])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        let file = try self.file
        let key = try key(createIfMissing: !fileManager.fileExists(atPath: file.path))
        let plaintext = try JSONEncoder().encode(Snapshot(version: 1, state: snapshot))
        guard plaintext.count <= maximumBytes - 64 else { throw HistoryError.invalid }
        let box = try AES.GCM.seal(plaintext, using: key, authenticating: aad)
        guard let ciphertext = box.combined else { throw HistoryError.storage }
        try ciphertext.write(to: file, options: [.atomic, .completeFileProtection])
    }

    /// Removes this app's current file only, not OS backups or forensic remnants.
    func clear() throws {
        let file = try self.file
        if fileManager.fileExists(atPath: file.path) { try fileManager.removeItem(at: file) }
    }

    private func key(createIfMissing: Bool) throws -> SymmetricKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, data.count == 32 {
            return SymmetricKey(data: data)
        }
        guard status == errSecItemNotFound, createIfMissing else { throw HistoryError.keyUnavailable }
        let generated = SymmetricKey(size: .bits256)
        let bytes = generated.withUnsafeBytes { Data($0) }
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: bytes,
        ]
        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        if addStatus == errSecDuplicateItem { return try key(createIfMissing: false) }
        guard addStatus == errSecSuccess else { throw HistoryError.keyUnavailable }
        return generated
    }
}
