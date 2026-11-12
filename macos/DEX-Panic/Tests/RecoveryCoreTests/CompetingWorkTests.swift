import XCTest
@testable import RecoveryCore

private final class ReadOnlyWorkRunner: CommandRunning {
    var calls: [CommandSpec] = []
    var responses: [CommandResult] = []

    func run(_ spec: CommandSpec) -> CommandResult {
        calls.append(spec)
        guard !responses.isEmpty else {
            return CommandResult(exitCode: nil, timedOut: false, startError: "No response")
        }
        return responses.removeFirst()
    }
}

final class CompetingWorkTests: XCTestCase {
    let cpuSample = """
      688     1 111.1 515856 /opt/homebrew/bin/node
      872     1  41.7 6932656 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine
      185     1   7.6 57344 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer
      100   688  13.4 122880 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser Helper
    """
    let memorySample = """
      872     1  12.3 6932656 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine
      824   324   2.4 524592 /Applications/Jellyfin.app/Contents/MacOS/jellyfin
      688     1  71.8 515856 /opt/homebrew/bin/node
    """

    func testParserUsesExecutableBasenameAndHandlesSpaces() {
        let parsed = WorkProcessParser.parse(cpuSample)
        XCTAssertEqual(parsed.count, 4)
        XCTAssertEqual(parsed[0].name, "node")
        XCTAssertEqual(parsed[0].category, "General runtime")
        XCTAssertEqual(parsed[0].cpuPercent, 111.1, accuracy: 0.01)
        XCTAssertEqual(parsed[1].residentMiB, 6770.171875, accuracy: 0.05)
        XCTAssertEqual(parsed[3].name, "Brave Browser Helper")
        XCTAssertFalse(parsed[0].name.contains("/opt/homebrew"))
    }

    func testParserRejectsMalformedAndSanitizesNames() {
        let raw = """
        nonsense
        50 1 nan 150 /tmp/bad
        51 1 -1 150 /tmp/bad
        52 1 45 -20 /tmp/bad
        53 1 4.5 500 /Users/andrew/Downloads/private-token-file.exe
        54 1 12.5 600 /home/someone/other|name
        """
        let values = WorkProcessParser.parse(raw)
        XCTAssertEqual(values.count, 2)
        XCTAssertEqual(values[0].name, "private-token-file.exe")
        XCTAssertEqual(values[1].name, "othername")
        XCTAssertFalse(values.map(\.name).joined().contains("/"))
    }

    func testShortlistIncludesCPUAndMemoryAndDeduplicates() {
        let cpu = WorkProcessParser.parse(cpuSample)
        let mem = WorkProcessParser.parse(memorySample)
        let result = WorkProcessParser.shortlist(cpu: cpu, memory: mem, limit: 5)
        XCTAssertEqual(result.count, 5)
        XCTAssertEqual(Set(result.map(\.pid)).count, 5)
        XCTAssertTrue(result.contains(where: { $0.name == "jellyfin" }))
        XCTAssertTrue(result.contains(where: { $0.name == "node" }))
    }

    func testLocalInspectorRunsOnlyPsReadOperations() {
        let fake = ReadOnlyWorkRunner()
        fake.responses = [
            .init(exitCode: 0, timedOut: false, output: cpuSample),
            .init(exitCode: 0, timedOut: false, output: memorySample)
        ]
        let result = CompetingWorkInspector(runner: fake, host: .macBook).inspectMacBook()
        XCTAssertEqual(result.host, .macBook)
        XCTAssertEqual(result.status, .observed)
        XCTAssertEqual(fake.calls.map(\.executable), ["/bin/ps", "/bin/ps"])
        XCTAssertEqual(fake.calls[0].arguments.first, "-axro")
        XCTAssertEqual(fake.calls[1].arguments.first, "-axmo")
        XCTAssertTrue(fake.calls.allSatisfy { $0.workingDirectory == nil })
    }

    func testLocalInspectorLabelsFailedPartialOrUnavailable() {
        let fake = ReadOnlyWorkRunner()
        fake.responses = [
            .init(exitCode: nil, timedOut: true),
            .init(exitCode: 0, timedOut: false, output: memorySample)
        ]
        XCTAssertEqual(CompetingWorkInspector(runner: fake, host: .macBook).inspectMacBook().status, .partial)
        fake.responses = [
            .init(exitCode: nil, timedOut: true),
            .init(exitCode: nil, timedOut: true)
        ]
        XCTAssertEqual(CompetingWorkInspector(runner: fake, host: .macBook).inspectMacBook().status, .unavailable)
    }

    func testBigMacIsPinnedToVerifiedHostAndReadOnlyCommands() {
        let fake = ReadOnlyWorkRunner()
        fake.responses = [
            .init(exitCode: 0, timedOut: false, output:
                "DEX_PANIC_NODE_BIGMAC_VERIFIED\nDEX_PANIC_CPU\n" + cpuSample +
                "\nDEX_PANIC_MEMORY\n" + memorySample + "\n")
        ]
        let result = CompetingWorkInspector(runner: fake, host: .macBook).inspectBigMac()
        XCTAssertEqual(result.host, .bigMac)
        XCTAssertEqual(result.status, .observed)
        XCTAssertEqual(fake.calls.count, 1)
        XCTAssertEqual(fake.calls[0].executable, "/usr/bin/ssh")
        XCTAssertTrue(fake.calls[0].arguments.contains("westcat"))
        XCTAssertTrue(fake.calls[0].arguments.contains("StrictHostKeyChecking=yes"))
        let script = fake.calls[0].arguments.last ?? ""
        XCTAssertTrue(script.contains("hostname -s"))
        XCTAssertTrue(script.contains("id -un"))
        XCTAssertTrue(script.contains("bigmac"))
        XCTAssertTrue(script.contains("/bin/ps -axro"))
        XCTAssertFalse(script.contains("kill "))
        XCTAssertFalse(script.contains("launchctl"))
        XCTAssertFalse(script.contains("sudo"))
        XCTAssertFalse(script.contains("rm -"))
    }

    func testRemoteHostMismatchUnavailableAndNeverFallsBack() {
        let fake = ReadOnlyWorkRunner()
        fake.responses = [.init(exitCode: 42, timedOut: false, output: "identity mismatch")]
        let result = CompetingWorkInspector(runner: fake, host: .macBook).inspectBigMac()
        XCTAssertEqual(result.status, .unavailable)
        XCTAssertTrue(result.processes.isEmpty)
        XCTAssertEqual(fake.calls.count, 1)
    }

    func testRemoteMarkerRequiredEvenWhenExitZero() {
        let fake = ReadOnlyWorkRunner()
        fake.responses = [.init(exitCode: 0, timedOut: false, output: cpuSample)]
        XCTAssertEqual(CompetingWorkInspector(runner: fake, host: .macBook).inspectBigMac().status, .unavailable)
        fake.responses = [.init(exitCode: 0, timedOut: false, output:
            "an untrusted banner\nDEX_PANIC_NODE_BIGMAC_VERIFIED\nDEX_PANIC_CPU\n" +
            cpuSample + "\nDEX_PANIC_MEMORY\n" + memorySample)]
        XCTAssertEqual(CompetingWorkInspector(runner: fake, host: .macBook).inspectBigMac().status, .unavailable)
    }

    func testShareReportCarriesSanitizedMachineSnapshotsWithoutArgsOrPIDs() {
        let fakeEntry = WorkProcess(pid: 876543, parentPID: 1, name: "sk-proj-SECRET /Users/andrew/secret",
                                    cpuPercent: 75, residentMiB: 250, category: "Other",
                                    explanation: "secret /Users/andrew hidden", isRelevantCandidate: true)
        let legitimate = WorkProcess(pid: 45789, parentPID: 1, name: "node",
                                     cpuPercent: 120.5, residentMiB: 530, category: "General runtime",
                                     explanation: "Generic runtime", isRelevantCandidate: true)
        let remote = WorkHostSnapshot(host: .bigMac, status: .observed,
                                      processes: [legitimate, fakeEntry], explanation: "some path /Users/andrew")
        let report = DiagnosticReport.render(DiagnosticSnapshot(
            probes: [], lastChecked: nil, refreshInFlight: false,
            admissionNote: "NOT INSPECTED", admissionChecked: nil,
            workSnapshots: [.bigMac: remote],
            authorityNote: "NOT INSPECTED", authorityChecked: nil, logFull: false, incidents: []))
        XCTAssertTrue(report.contains("Big Mac [bigmac]: observed"))
        XCTAssertTrue(report.contains("node | CPU 120.5% | RSS 530 MiB"))
        XCTAssertTrue(report.contains("[process name withheld]"))
        XCTAssertTrue(report.contains("MacBook Air [macbook-air.local]: not inspected"))
        XCTAssertFalse(report.contains("876543"))
        XCTAssertFalse(report.contains("45789"))
        XCTAssertFalse(report.contains("/Users/andrew"))
        XCTAssertFalse(report.contains("sk-proj-SECRET"))
        XCTAssertFalse(report.contains("some path"))
        XCTAssertFalse(report.contains("Generic runtime"))
    }

    func testBigMacLocalIsNotRelabeledAsMacBook() {
        let fake = ReadOnlyWorkRunner()
        fake.responses = [.init(exitCode: 0, timedOut: false, output: cpuSample),
                          .init(exitCode: 0, timedOut: false, output: memorySample)]
        let sample = CompetingWorkInspector(runner: fake, host: .bigMac).inspectBigMac()
        XCTAssertEqual(sample.host, .bigMac)
        XCTAssertEqual(sample.status, .observed)
        XCTAssertEqual(fake.calls.map(\.executable), ["/bin/ps", "/bin/ps"])
    }

    func testNoPIDOrCommandLineContentsNeededForExplanation() {
        let explained = ProcessExplanation.classify("node")
        XCTAssertTrue(explained.1.contains("cannot identify"))
        let system = ProcessExplanation.classify("WindowServer")
        XCTAssertEqual(system.0, "macOS system")
        XCTAssertFalse(system.2)
    }
}
