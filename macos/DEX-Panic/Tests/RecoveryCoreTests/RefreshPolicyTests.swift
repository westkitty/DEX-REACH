import XCTest
@testable import RecoveryCore

final class RefreshPolicyTests: XCTestCase {
    func testRecentMenuOpenDoesNotDuplicatePeriodicProbe() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertFalse(RefreshPolicy.needsMenuProbe(lastChecked: now.addingTimeInterval(-3), now: now))
        XCTAssertFalse(RefreshPolicy.needsMenuProbe(lastChecked: now.addingTimeInterval(-7), now: now))
        XCTAssertTrue(RefreshPolicy.needsMenuProbe(lastChecked: now.addingTimeInterval(-8), now: now))
        XCTAssertTrue(RefreshPolicy.needsMenuProbe(lastChecked: now.addingTimeInterval(-20), now: now))
    }

    func testMissingAndFutureObservationsNeverAssumeFreshHealth() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertTrue(RefreshPolicy.needsMenuProbe(lastChecked: nil, now: now))
        XCTAssertTrue(RefreshPolicy.needsMenuProbe(lastChecked: now.addingTimeInterval(15), now: now))
    }
}
