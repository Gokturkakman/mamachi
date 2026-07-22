import Foundation
import XCTest
@testable import Mamachi

final class DiagnosticsPrivacyTests: XCTestCase {
    @MainActor
    func testPreviewIsBoundedAndDropsSecretShapedRequestIDs() throws {
        let diagnostics = DiagnosticsService()
        for index in 0..<120 {
            diagnostics.recordTransition(
                component: .daemon,
                from: .starting,
                to: .connected,
                elapsedMilliseconds: index == 119 ? 900_000 : index
            )
        }
        diagnostics.recordProviderRequestID("req_safe-123")
        diagnostics.recordProviderRequestID("sk-super-secret")

        let data = try diagnostics.previewData()
        let preview = String(decoding: data, as: UTF8.self)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(DiagnosticSnapshot.self, from: data)

        XCTAssertEqual(decoded.transitions.count, 100)
        XCTAssertEqual(decoded.transitions.last?.elapsedMilliseconds, 600_000)
        XCTAssertEqual(decoded.providerRequestIDs, ["req_safe-123"])
        XCTAssertFalse(preview.contains("sk-super-secret"))
        XCTAssertFalse(preview.lowercased().contains("transcript"))
        XCTAssertFalse(preview.lowercased().contains("credential"))
        XCTAssertFalse(preview.lowercased().contains("audio"))
    }

    func testPrivacyGateRejectsProhibitedFieldsBeforeExport() throws {
        let unsafe = try JSONSerialization.data(withJSONObject: ["toolArguments": ["command": "cat .env"]])
        XCTAssertThrowsError(try DiagnosticsPrivacyPolicy().validate(unsafe))
    }
}
