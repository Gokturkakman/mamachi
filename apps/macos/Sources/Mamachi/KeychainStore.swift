import Foundation
import Security

enum CodingProvider: String, CaseIterable, Identifiable {
    case anthropic
    case openAI
    case google

    var id: String { rawValue }

    var label: String {
        switch self {
        case .anthropic: "Anthropic"
        case .openAI: "OpenAI (coding)"
        case .google: "Google Gemini"
        }
    }

    var environmentVariable: String {
        switch self {
        case .anthropic: "ANTHROPIC_API_KEY"
        case .openAI: "OPENAI_API_KEY"
        case .google: "GEMINI_API_KEY"
        }
    }
}

struct KeychainStore {
    private let service = "com.mamachi.app"
    private let realtimeAccount = "openai-realtime-api-key"
    private let legacyRealtimeAccount = "openai-api-key"
    private let encryptionAccount = "application-encryption-key-v1"

    func loadAPIKey() throws -> String? {
        if let key = try loadString(account: realtimeAccount) { return key }
        return try loadString(account: legacyRealtimeAccount)
    }

    func saveAPIKey(_ key: String) throws {
        try save(Data(key.utf8), account: realtimeAccount)
        try delete(account: legacyRealtimeAccount)
    }

    func deleteAPIKey() throws {
        try delete(account: realtimeAccount)
        try delete(account: legacyRealtimeAccount)
    }

    func loadCodingCredential(for provider: CodingProvider) throws -> String? {
        try loadString(account: codingAccount(provider))
    }

    func saveCodingCredential(_ credential: String, for provider: CodingProvider) throws {
        try save(Data(credential.utf8), account: codingAccount(provider))
    }

    func deleteCodingCredential(for provider: CodingProvider) throws {
        try delete(account: codingAccount(provider))
    }

    func codingCredentialEnvironment() throws -> [String: String] {
        var result: [String: String] = [:]
        for provider in CodingProvider.allCases {
            if let credential = try loadCodingCredential(for: provider), !credential.isEmpty {
                result[provider.environmentVariable] = credential
            }
        }
        return result
    }

    func loadOrCreateApplicationEncryptionKey() throws -> Data {
        if let existing = try loadData(account: encryptionAccount) {
            guard existing.count == 32 else { throw KeychainError.invalidEncryptionKey }
            return existing
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        let key = Data(bytes)
        try save(key, account: encryptionAccount)
        return key
    }

    private func codingAccount(_ provider: CodingProvider) -> String {
        "coding-provider-\(provider.rawValue)-api-key"
    }

    private func loadString(account: String) throws -> String? {
        guard let data = try loadData(account: account) else { return nil }
        guard let value = String(data: data, encoding: .utf8) else { throw KeychainError.invalidData }
        return value
    }

    private func loadData(account: String) throws -> Data? {
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
        guard let data = item as? Data else { throw KeychainError.invalidData }
        return data
    }

    private func save(_ data: Data, account: String) throws {
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

    private func delete(account: String) throws {
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
    case invalidEncryptionKey
    case status(OSStatus)

    init(status: OSStatus) {
        self = .status(status)
    }

    var errorDescription: String? {
        switch self {
        case .invalidData:
            "The Keychain item is not valid UTF-8 data."
        case .invalidEncryptionKey:
            "The application encryption key in Keychain has an invalid length."
        case .status(let status):
            SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)"
        }
    }
}
