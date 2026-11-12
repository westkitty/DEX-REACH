import XCTest
@testable import RecoveryCore

final class DiagnosticsTests: XCTestCase {
    private func make(_ state: ServiceState, detail: String) -> [ServiceProbe] {
        ServiceRegistry.reach.map { ServiceProbe(service: $0, state: state, detail: detail) }
    }

    func testAllTimeoutsAreAnInspectionFailureNotAStoppedService() {
        let finding = ProbeExplanation.assess(make(.unknown, detail: "Probe timed out"))
        XCTAssertEqual(finding.kind, "timeout")
        XCTAssertTrue(finding.meaning.contains("4-second"))
        XCTAssertTrue(finding.meaning.contains("does NOT prove"))
        XCTAssertTrue(finding.nextStep.contains("Do not restart"))
    }

    func testConfirmedStoppedServicePrioritizedOverOtherTimedOutChecks() {
        var probes = make(.unknown, detail: "Probe timed out")
        probes[0] = ServiceProbe(service: ServiceRegistry.reach[0],
                                 state: .stopped, detail: "Loaded, not running")
        let finding = ProbeExplanation.assess(probes)
        XCTAssertEqual(finding.kind, "confirmed-stopped")
        XCTAssertTrue(finding.nextStep.contains("Check for active tasks"))
    }

    func testRequiredHealthyButOptionalUnknownDoesNotImplyFullTaskHealth() {
        let probes = ServiceRegistry.reach.map { service in
            ServiceProbe(service: service, state: service.required ? .running : .unknown,
                         detail: service.required ? "Running" : "Probe timed out")
        }
        let finding = ProbeExplanation.assess(probes)
        XCTAssertEqual(finding.kind, "optional-unknown")
        XCTAssertEqual(HealthClassifier.classify(probes), .healthy)
        XCTAssertTrue(finding.nextStep.contains("Inspect work admission"))
    }

    func testReportContainsUsefulObservationsWithoutDangerousSecrets() {
        let injected = "password=secret123 token=sk-proj-accidental /Users/andrew/.dex-reach/access.json"
        let records = [
            IncidentRecord(timestamp: "2026-11-12T17:25:00Z", action: "state-change",
                           target: "gateway", outcome: "running-to-unknown"),
            IncidentRecord(timestamp: "2026-11-12T17:26:00Z", action: injected,
                           target: injected, outcome: injected),
            IncidentRecord(timestamp: "2026-11-12T17:27:00Z", action: "state-change",
                           target: "node", outcome: injected)
        ]
        let report = DiagnosticReport.render(DiagnosticSnapshot(
            probes: make(.unknown, detail: injected),
            lastChecked: Date(timeIntervalSince1970: 1_700_000_000),
            refreshInFlight: true, admissionNote: injected, admissionChecked: nil,
            authorityNote: injected, authorityChecked: nil, logFull: false,
            incidents: records, capturedAt: Date(timeIntervalSince1970: 1_700_000_120)))
        XCTAssertTrue(report.contains("gateway [required]: unknown"))
        XCTAssertTrue(report.contains("last inspection (UTC): not inspected"))
        XCTAssertTrue(report.contains("Work admission: NOT VERIFIED"))
        XCTAssertTrue(report.contains("Owner policy: NOT VERIFIED"))
        XCTAssertTrue(report.contains("running-to-unknown"))
        XCTAssertTrue(report.contains("state transition details omitted"))
        XCTAssertTrue(report.contains("Snapshot age (seconds): 120"))
        XCTAssertFalse(report.contains(injected))
        XCTAssertFalse(report.contains("secret123"))
        XCTAssertFalse(report.contains("sk-proj"))
        XCTAssertFalse(report.contains("/Users/andrew"))
        XCTAssertLessThan(report.utf8.count, 12001)
    }

    func testMissingAndDuplicateRequiredProbeCannotBeExplainedAsRunning() {
        let first = ServiceRegistry.reach[0]
        let fragment = ServiceProbe(service: first, state: .running, detail: "Running")
        XCTAssertEqual(ProbeExplanation.assess([fragment]).kind, "incomplete")
        XCTAssertEqual(ProbeExplanation.assess([fragment, fragment]).kind, "incomplete")
    }

    func testCapacityEvidenceExtractsOnlyAllowlistedPressureAndCounts() {
        let text = "Memory pressure:  warning\nCPU pressure: busy\nThermal: unknown\nActive leases: 2\nQueue depth: 3\nUncoordinated heavy jobs: 4\nHost: secret_host\n"
        let result = CommandResult(exitCode: 0, timedOut: false, output: text)
        let evidence = WorkEvidenceParser.parse(result)
        XCTAssertEqual(evidence?.memory, "warning")
        XCTAssertEqual(evidence?.cpu, "busy")
        XCTAssertEqual(evidence?.thermal, "unknown")
        XCTAssertEqual(evidence?.queueDepth, 3)
        XCTAssertEqual(evidence?.activeLeases, 2)
        XCTAssertEqual(evidence?.uncoordinatedHeavy, 4)
        let report = DiagnosticReport.render(DiagnosticSnapshot(
            probes: make(.unknown, detail: "Probe timed out"),
            lastChecked: nil, refreshInFlight: false, admissionNote: "QUEUED AT CHECK",
            admissionChecked: nil, workEvidence: evidence, authorityNote: "NOT INSPECTED",
            authorityChecked: nil, logFull: false, incidents: []))
        XCTAssertTrue(report.contains("Work memory pressure: warning"))
        XCTAssertTrue(report.contains("Work CPU pressure: busy"))
        XCTAssertTrue(report.contains("Uncoordinated heavy jobs: 4"))
        XCTAssertFalse(report.contains("secret_host"))
    }

    func testCapacityEvidenceRejectsDuplicatesInvalidNumbersAndFailedCommands() {
        let sample = "Memory pressure: healthy\nCPU pressure: saturated\nQueue depth: 1000000000\n"
        let result = CommandResult(exitCode: 0, timedOut: false, output: sample)
        let evidence = WorkEvidenceParser.parse(result)
        XCTAssertEqual(evidence?.cpu, "saturated")
        XCTAssertNil(evidence?.queueDepth)
        XCTAssertNil(WorkEvidenceParser.parse(CommandResult(exitCode: 1, timedOut: false, output: sample)))
        XCTAssertNil(WorkEvidenceParser.parse(CommandResult(exitCode: 0, timedOut: true, output: sample)))
        XCTAssertNil(WorkEvidenceParser.parse(CommandResult(exitCode: 0, timedOut: false,
            output: sample + "Memory pressure: warning\n")))
    }

    func testDiagnosticInterpretationUsesCanonicalServiceNameNotUntrustedObjectTitle() {
        let canon = ServiceRegistry.reach[0]
        let spoof = ManagedService(id: canon.id, title: "password=evil", launchdLabel: canon.launchdLabel, required: true)
        var probes = make(.running, detail: "Running")
        probes[0] = ServiceProbe(service: spoof, state: .stopped, detail: "Loaded, not running")
        let finding = ProbeExplanation.assess(probes)
        XCTAssertEqual(finding.kind, "confirmed-stopped")
        XCTAssertFalse(finding.meaning.contains("password"))
        let report = DiagnosticReport.render(DiagnosticSnapshot(
            probes: probes, lastChecked: nil, refreshInFlight: false,
            admissionNote: "NOT INSPECTED", admissionChecked: nil,
            authorityNote: "NOT INSPECTED", authorityChecked: nil,
            logFull: false, incidents: []))
        XCTAssertTrue(report.contains("Gateway"))
        XCTAssertFalse(report.contains("evil"))
    }

    func testNotLoadedIsNotAnInstallationSuggestion() {
        var probes = make(.running, detail: "Running")
        probes[1] = ServiceProbe(service: ServiceRegistry.reach[1],
                                 state: .notInstalled, detail: "Not loaded")
        let finding = ProbeExplanation.assess(probes)
        XCTAssertEqual(finding.kind, "not-loaded")
        XCTAssertTrue(finding.nextStep.contains("never installs"))
    }
}
