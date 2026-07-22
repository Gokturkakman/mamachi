import XCTest
@testable import Mamachi

final class ProtocolIDTests: XCTestCase {
    func testGeneratesProtocolCompatibleUUIDv7Identifiers() {
        let identifiers = (0..<64).map { _ in ProtocolID.makeV7() }
        let pattern = #"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#

        XCTAssertEqual(Set(identifiers).count, identifiers.count)
        for identifier in identifiers {
            XCTAssertNotNil(identifier.range(of: pattern, options: .regularExpression))
        }
    }
}
