import XCTest
@testable import RecoveryCore

private final class EvidenceRunner: CommandRunning {
    var responses: [CommandResult] = []
    var commands: [CommandSpec] = []
    func run(_ spec: CommandSpec) -> CommandResult {
        commands.append(spec)
        return responses.isEmpty ? .init(exitCode: nil, timedOut: false, startError: "no stub") : responses.removeFirst()
    }
}

final class OwnerEvidenceTests: XCTestCase {
    private let coordinator = """
    {"schemaVersion":1,"nodeId":"bigmac","observedAtUtc":"2026-11-12T19:00:00Z",
      "observed":{"processObservation":"observed","uncoordinatedHeavy":2,
        "detailsComplete":true,"uncoordinatedDetails":[
        {"group":1,"processLabel":"swift","cpu":112.4,"mem":3.2,"members":2,"matchedBy":"cpu"},
        {"group":2,"processLabel":"python","cpu":12,"mem":8,"members":1,"matchedBy":"memory"}
      ]},
      "capacity":{"memory":"healthy","cpu":"busy","thermal":"unknown","canAdmit":false}}
    """

    private let taskProjection = """
    {"schemaVersion":1,"nodeId":"bigmac","observedAtUtc":"2026-11-12T19:00:00Z","complete":true,"tasks":[
      {"taskId":"rtsk_aaaaaaaaaaa_bbbbbbbbbbbbbbbb","nodeId":"bigmac","operation":"dex.process.run",
       "state":"AMBIGUOUS","updatedAtUtc":"2026-11-12T18:55:12.123Z","resultRecorded":false},
      {"taskId":"rtsk_ccccccccccc_dddddddddddddddd","nodeId":"bigmac","operation":"dex.fingerprint",
       "state":"COMPLETED","updatedAtUtc":"2026-11-12T18:56:10Z","resultRecorded":true}
      ]}
    """

    func testClassifiedProjectionRequiresCompleteSameNode() {
        let value = OwnerEvidenceParser.classify(
            .init(exitCode: 0, timedOut: false, output: "> dex-reach\n> tsx\n" + coordinator),
            host: .bigMac)
        XCTAssertEqual(value.state, .observed)
        XCTAssertEqual(value.reportedCount, 2)
        XCTAssertEqual(value.groups.count, 2)
        XCTAssertEqual(value.groups[0].name, "swift")
        XCTAssertEqual(value.groups[0].members, 2)
        XCTAssertFalse(value.explanation.contains("775"))
        XCTAssertEqual(OwnerEvidenceParser.classify(
            .init(exitCode: 0, timedOut: false, output: coordinator), host: .macBook).state, .partial)
    }

    func testInvalidOrMissingClassifiedDetailsNeverClaimsAttribution() {
        let malformed = coordinator.replacingOccurrences(of: "\"detailsComplete\":true", with: "\"detailsComplete\":false")
        let output = OwnerEvidenceParser.classify(
            .init(exitCode: 0, timedOut: false, output: malformed), host: .bigMac)
        XCTAssertEqual(output.state, .partial)
        XCTAssertTrue(output.groups.isEmpty)
        let absent = OwnerEvidenceParser.classify(.init(exitCode: nil, timedOut: true), host: .bigMac)
        XCTAssertEqual(absent.state, .unavailable)
    }

    func testTaskProjectionHandlesAmbiguousAndTerminalWithoutReplaying() {
        let value = OwnerEvidenceParser.tasks(
            .init(exitCode: 0, timedOut: false, output: "> dex-reach\n" + taskProjection),
            host: .bigMac)
        XCTAssertEqual(value.state, .observed)
        XCTAssertEqual(value.tasks.count, 2)
        XCTAssertEqual(value.tasks[0].state, "AMBIGUOUS")
        XCTAssertTrue(value.tasks[0].guidance.contains("Do not replay"))
        XCTAssertFalse(value.tasks[0].resultRecorded)
        XCTAssertEqual(value.tasks[1].state, "COMPLETED")
        XCTAssertTrue(value.tasks[1].resultRecorded)
    }

    func testTaskProjectionRejectsCrossNodeAndInvalidDatetime() {
        XCTAssertEqual(OwnerEvidenceParser.tasks(.init(exitCode: 0, timedOut: false,
            output: taskProjection), host: .macBook).state, .partial)
        let malformed = taskProjection.replacingOccurrences(of: "2026-11-12T18:55:12.123Z", with: "not-a-date")
        XCTAssertEqual(OwnerEvidenceParser.tasks(.init(exitCode: 0, timedOut: false,
            output: malformed), host: .bigMac).state, .partial)
    }

    func testBigMacRemoteCommandHasOnlyReadOperations() {
        let fake = EvidenceRunner()
        fake.responses = [.init(exitCode: 0, timedOut: false,
                                output: "DEX_PANIC_BIGMAC_CLI_VERIFIED\n" + coordinator)]
        let snapshot = OwnerEvidenceInspector(runner: fake, profile: .macBook).attribution(host: .bigMac)
        XCTAssertEqual(snapshot.state, .observed)
        XCTAssertEqual(fake.commands.count, 1)
        XCTAssertEqual(fake.commands[0].executable, "/usr/bin/ssh")
        XCTAssertTrue(fake.commands[0].arguments.contains("westcat"))
        let command = fake.commands[0].arguments.last ?? ""
        XCTAssertTrue(command.contains("work-status --panic"))
        XCTAssertTrue(command.contains("hostname -s"))
        XCTAssertTrue(command.contains("id -un"))
        XCTAssertFalse(command.contains("kill "))
        XCTAssertFalse(command.contains("restart"))
        XCTAssertFalse(command.contains("sudo "))
        XCTAssertFalse(command.contains("--json"))
    }

    func testWrongRemoteMarkerAndUnknownSourceFailClosed() {
        let fake = EvidenceRunner()
        fake.responses = [.init(exitCode: 0, timedOut: false, output: coordinator)]
        XCTAssertEqual(OwnerEvidenceInspector(runner: fake, profile: .macBook).attribution(host: .bigMac).state, .unavailable)
        let unseen = EvidenceRunner()
        XCTAssertEqual(OwnerEvidenceInspector(runner: unseen, profile: .unknown).autopsy(host: .bigMac).state, .unavailable)
        XCTAssertTrue(unseen.commands.isEmpty)
        XCTAssertEqual(OwnerEvidenceInspector(runner: unseen, profile: .bigMac).attribution(host: .macBook).state, .unavailable)
        XCTAssertTrue(unseen.commands.isEmpty)
    }

    func testHostProfilesKeepBigMacLocalServicesDistinct() {
        XCTAssertEqual(HostProfile.detect(hostname: "MacBook-Air.local", user: "andrew"), .macBook)
        XCTAssertEqual(HostProfile.detect(hostname: "bigmac", user: "bigmac"), .bigMac)
        XCTAssertEqual(HostProfile.detect(hostname: "bigmac", user: "andrew"), .unknown)
        XCTAssertEqual(HostProfile.bigMac.services.map(\.id), ["node"])
        XCTAssertEqual(HostProfile.macBook.services.count, 4)
        XCTAssertFalse(HostProfile.bigMac.canControlOwnerPolicy)
    }
}
