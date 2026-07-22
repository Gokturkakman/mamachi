import Foundation
import Security

struct KeychainStore {
    private let service = "com.mamachi.app"
    private let account = "openai-api-key"

    func loadAPIKey() throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        guard let data = item as? Data, let key = String(data: data, encoding: .utf8) else {
            throw KeychainError.invalidData
        }
        return key
    }

    func saveAPIKey(_ key: String) throws {
        let data = Data(key.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var inserted = query
            inserted[kSecValueData as String] = data
            let addStatus = SecItemAdd(inserted as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
            return
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    func deleteAPIKey() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }
}

enum KeychainError: LocalizedError {
    case invalidData
    case status(OSStatus)

    init(status: OSStatus) {
        self = .status(status)
    }

    var errorDescription: String? {
        switch self {
        case .invalidData:
            "The stored OpenAI API key is not valid UTF-8."
        case .status(let status):
            SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)"
        }
    }
}
