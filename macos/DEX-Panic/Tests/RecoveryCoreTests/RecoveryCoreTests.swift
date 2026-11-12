import XCTest
@testable import RecoveryCore

final class FakeRunner: CommandRunning {
    var calls: [CommandSpec] = []
    var next = CommandResult(exitCode: 0, timedOut: false, output: "state = running\n pid = 42")
    var queued: [CommandResult] = []
    func run(_ spec: CommandSpec) -> CommandResult {
        calls.append(spec)
        if !queued.isEmpty { return queued.removeFirst() }
        return next
    }
}

final class RecoveryCoreTests: XCTestCase {
    let service = ServiceRegistry.reach[0]

    func testLaunchctlRunningAndWaiting() {
        XCTAssertEqual(LaunchctlParser.parse(output: "path = /foo\n state = running\n pid = 421\n", exitCode: 0), .running)
        XCTAssertEqual(LaunchctlParser.parse(output: "state = waiting\n", exitCode: 0), .stopped)
        XCTAssertEqual(LaunchctlParser.parse(output: "state = exited\n", exitCode: 0), .stopped)
    }

    func testLaunchctlUnknownIsNotCalledHealthyOrAbsent() {
        XCTAssertEqual(LaunchctlParser.parse(output: "state = some new value\n", exitCode: 0), .unknown)
        XCTAssertEqual(LaunchctlParser.parse(output: "Permission denied", exitCode: 1), .unknown)
        XCTAssertEqual(LaunchctlParser.parse(output: "Could not find service 'x'", exitCode: 113), .notInstalled)
    }

    func testUnknownAndRunningCannotUseStartStopped() {
        for state in [ServiceState.unknown, .running, .notInstalled] {
            let probe = ServiceProbe(service: service, state: state, detail: "")
            if case .blocked = RecoveryGuard.decide(.startStopped, for: probe) {} else {
                XCTFail("Unsafe start permitted for \(state)")
            }
        }
    }

    func testRunningRestartNeedsOwnerConfirmation() {
        let probe = ServiceProbe(service: service, state: .running, detail: "")
        XCTAssertEqual(RecoveryGuard.decide(.forceRestart, for: probe), .confirmationRequired)
        let fake = FakeRunner()
        let manager = LaunchdSupervisor(runner: fake, userID: 501)
        let refused = manager.restart(probe, ownerConfirmed: false)
        XCTAssertFalse(refused.succeeded)
        XCTAssertTrue(fake.calls.isEmpty)
        let permitted = manager.restart(probe, ownerConfirmed: true)
        XCTAssertTrue(permitted.succeeded)
        XCTAssertEqual(fake.calls.map { $0.arguments[0] }, ["print", "kickstart"])
        XCTAssertEqual(fake.calls.last?.arguments, ["kickstart", "-k", "gui/501/com.stinkyweasel.dex-reach.gateway"])
    }

    func testUnknownRestartCannotCallLaunchctlEvenWithConfirmation() {
        let fake = FakeRunner()
        let probe = ServiceProbe(service: service, state: .unknown, detail: "")
        XCTAssertFalse(LaunchdSupervisor(runner: fake, userID: 501).restart(probe, ownerConfirmed: true).succeeded)
        XCTAssertTrue(fake.calls.isEmpty)
    }

    func testStoppedStartUsesNoKillFlag() {
        let fake = FakeRunner()
        let probe = ServiceProbe(service: service, state: .stopped, detail: "")
        fake.next = .init(exitCode: 0, timedOut: false, output: "state = waiting\n")
        let result = LaunchdSupervisor(runner: fake, userID: 501).start(probe)
        XCTAssertTrue(result.succeeded)
        XCTAssertEqual(fake.calls[0].executable, "/bin/launchctl")
        XCTAssertEqual(fake.calls[0].arguments, ["print", "gui/501/com.stinkyweasel.dex-reach.gateway"])
        XCTAssertEqual(fake.calls[1].arguments, ["kickstart", "gui/501/com.stinkyweasel.dex-reach.gateway"])
    }

    func testProbeReportsUnknownForTimeoutNotStopped() {
        let fake = FakeRunner()
        fake.next = .init(exitCode: nil, timedOut: true)
        let probe = LaunchdSupervisor(runner: fake, userID: 501).probe(service)
        XCTAssertEqual(probe.state, .unknown)
    }

    func testHealthDoesNotHideRequiredUnknown() {
        let base = ServiceRegistry.reach.filter(\.required)
        XCTAssertEqual(HealthClassifier.classify(base.map { .init(service: $0, state: .running, detail: "") }), .healthy)
        let mixed = base.enumerated().map { index, element in
            ServiceProbe(service: element, state: index == 0 ? .unknown : .running, detail: "")
        }
        XCTAssertEqual(HealthClassifier.classify(mixed), .unknown)
        XCTAssertEqual(HealthClassifier.classify([.init(service: base[0], state: .stopped, detail: "")]), .degraded)
    }

    func testIncidentLogContainsNoRawCommandOutput() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("dex-panic-test-\(UUID())")
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = IncidentLog(home: dir)
        XCTAssertTrue(log.record(action: "restart", target: "gateway", outcome: "Command completed"))
        let value = try String(contentsOf: log.logURL, encoding: .utf8)
        XCTAssertTrue(value.contains("gateway"))
        XCTAssertFalse(value.contains("password"))
    }

    func testAdmissionIsNotInferredFromHealthyDaemonsOrAbsentOutput() {
        let healthy = CommandResult(exitCode: 0, timedOut: false, output:
            "Memory pressure: healthy\nCPU pressure: healthy\nAdmission for a new medium mutating job: AVAILABLE\n")
        let queued = CommandResult(exitCode: 0, timedOut: false, output:
            "Memory pressure: warning\nAdmission for a new medium mutating job: QUEUE\n")
        XCTAssertEqual(WorkStatusParser.admission(healthy), .available)
        XCTAssertEqual(WorkStatusParser.admission(queued), .queued)
        XCTAssertEqual(WorkStatusParser.admission(.init(exitCode: 0, timedOut: false,
            output: "CPU pressure: healthy")), .unknown)
        XCTAssertEqual(WorkStatusParser.admission(.init(exitCode: nil, timedOut: true,
            output: healthy.output)), .unknown)
    }

    func testPolicyOffRequiresSeparateExactStatusReadback() {
        let off = CommandResult(exitCode: 0, timedOut: false,
            output: "DEX//REACH\nAI access:       DISABLED (all remote AI execution refused)\nProfile: development\n")
        XCTAssertEqual(OwnerStatusParser.accessMode(off), .off)
        XCTAssertEqual(OwnerStatusParser.accessMode(.init(exitCode: 0, timedOut: false, output: "Operation completed")), .unknown)
        XCTAssertEqual(OwnerStatusParser.accessMode(.init(exitCode: nil, timedOut: true, output: off.output)), .unknown)
        XCTAssertEqual(OwnerStatusParser.accessMode(.init(exitCode: 0, timedOut: false,
            output: off.output + "AI access: ENABLED (configured profile applies)\n")), .unknown)
        XCTAssertEqual(OwnerStatusParser.accessMode(.init(exitCode: 0, timedOut: false,
            output: "AI access:       READ-ONLY (shell-free inspection only)")), .readOnly)
        XCTAssertEqual(OwnerStatusParser.accessMode(.init(exitCode: 0, timedOut: false,
            output: "AI access:       ENABLED (configured profile applies)")), .on)
    }

    func testPartialOrDuplicateRequiredInventoryNeverLooksHealthy() {
        let required = ServiceRegistry.reach.filter(\.required)
        XCTAssertEqual(HealthClassifier.classify([.init(service: required[0], state: .running, detail: "")]), .unknown)
        let full = required.map { ServiceProbe(service: $0, state: .running, detail: "") }
        XCTAssertEqual(HealthClassifier.classify(full + [full[0]]), .unknown)
        XCTAssertEqual(HealthClassifier.classify(full), .healthy)
    }

    func testStartIsRefusedWhenFreshProbeChangedToRunning() {
        let fake = FakeRunner()
        let snapshot = ServiceProbe(service: service, state: .stopped, detail: "")
        XCTAssertFalse(LaunchdSupervisor(runner: fake, userID: 501).start(snapshot).succeeded)
        XCTAssertEqual(fake.calls.count, 1)
        XCTAssertEqual(fake.calls[0].arguments.first, "print")
    }

    func testRestartIsRefusedWhenFreshProbeChangedToStopped() {
        let fake = FakeRunner()
        fake.next = .init(exitCode: 0, timedOut: false, output: "state = waiting\n")
        let snapshot = ServiceProbe(service: service, state: .running, detail: "")
        XCTAssertFalse(LaunchdSupervisor(runner: fake, userID: 501).restart(snapshot, ownerConfirmed: true).succeeded)
        XCTAssertEqual(fake.calls.count, 1)
        XCTAssertEqual(fake.calls[0].arguments.first, "print")
    }

    func testInventedServiceIsNotActionable() {
        let fake = FakeRunner()
        let evil = ManagedService(id: "other", title: "Other", launchdLabel: "com.other.service", required: true)
        let snapshot = ServiceProbe(service: evil, state: .running, detail: "")
        XCTAssertFalse(LaunchdSupervisor(runner: fake, userID: 501).restart(snapshot, ownerConfirmed: true).succeeded)
        XCTAssertTrue(fake.calls.isEmpty)
    }

    func testIncidentTailIsPrivateAndBounded() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("dex-panic-tail-\(UUID())")
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = IncidentLog(home: dir)
        for i in 0..<60 { XCTAssertTrue(log.record(action: "health", target: "gateway", outcome: "observation-\(i)")) }
        let last = log.recent(limit: 4)
        XCTAssertEqual(last.count, 4)
        XCTAssertEqual(last.last?.outcome, "observation-59")
        XCTAssertEqual(log.recent(limit: 0).count, 0)
    }
}
