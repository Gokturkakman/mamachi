import CryptoKit
import Foundation

/// Versioned authenticated encryption for sensitive local fields.
/// The 32-byte application key is generated once and remains in macOS Keychain.
struct ApplicationEncryptionService {
    private let keyProvider: () throws -> Data

    init(keychain: KeychainStore = KeychainStore()) {
        keyProvider = { try keychain.loadOrCreateApplicationEncryptionKey() }
    }

    init(key: Data) {
        keyProvider = { key }
    }

    func prepareKey() throws {
        _ = try symmetricKey()
    }

    func encrypt(_ plaintext: Data) throws -> Data {
        let sealed = try AES.GCM.seal(plaintext, using: symmetricKey())
        guard let combined = sealed.combined else { throw EncryptionServiceError.couldNotEncode }
        return Data([Self.envelopeVersion]) + combined
    }

    func decrypt(_ envelope: Data) throws -> Data {
        guard envelope.first == Self.envelopeVersion else {
            throw EncryptionServiceError.unsupportedVersion
        }
        let box = try AES.GCM.SealedBox(combined: envelope.dropFirst())
        return try AES.GCM.open(box, using: symmetricKey())
    }

    func isEncryptedEnvelope(_ data: Data) -> Bool {
        data.first == Self.envelopeVersion
    }

    private func symmetricKey() throws -> SymmetricKey {
        let data = try keyProvider()
        guard data.count == 32 else { throw EncryptionServiceError.invalidKey }
        return SymmetricKey(data: data)
    }

    private static let envelopeVersion: UInt8 = 1
}

enum EncryptionServiceError: LocalizedError {
    case couldNotEncode
    case unsupportedVersion
    case invalidKey

    var errorDescription: String? {
        switch self {
        case .invalidKey: "The application encryption key must contain exactly 32 bytes."
        case .couldNotEncode: "The encrypted value could not be encoded."
        case .unsupportedVersion: "The encrypted value uses an unsupported version."
        }
    }
}
