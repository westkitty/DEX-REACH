#if os(macOS)
import AppKit
import SwiftUI
import Foundation
import RecoveryCore

final class DEXPanicMenuBar: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let runner = SystemProcessRunner()
    private lazy var launchd = LaunchdSupervisor(runner: runner)
    private lazy var cli = OwnerCLI(runner: runner)
    private let ledger = IncidentLog()
    private var statusItem: NSStatusItem!
    private var menu = NSMenu(title: "DEX//PANIC")
    private var timer: Timer?
    private var probes: [ServiceProbe] = []
    private var priorStates: [String: ServiceState] = [:]
    private var refreshInFlight = false
    private var actionInFlight = false
    private var lastCheck: Date?
    private var lastConfirmedRunning: [String: Date] = [:]
    private var lastProbeCycleMilliseconds: Int?
    private var logFull = false
    private let deckModel = RecoveryDeckModel()
    private var deckWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Single operator surface: Big Mac is an information-only source, not a second menu app.
        guard HostProfile.current == .macBook else { NSApp.terminate(nil); return }
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = makeStatusIcon(for: .unknown)
        statusItem.button?.imageScaling = .scaleProportionallyDown
        statusItem.button?.toolTip = "DEX//PANIC: checking local services"
        menu.delegate = self
        statusItem.menu = menu
        deckModel.onRefresh = { [weak self] in self?.refresh() }
        deckModel.onDisable = { [weak self] in self?.disableRemoteAI() }
        deckModel.onCapacity = { [weak self] in self?.showWorkStatus() }
        deckModel.onAuthority = { [weak self] in self?.showOwnerStatus() }
        deckModel.onOpenLog = { [weak self] in self?.revealLog() }
        deckModel.onCopyDiagnostics = { [weak self] in self?.copyDiagnostics() }
        deckModel.onInspectCompetingWork = { [weak self] in self?.inspectCompetingWork() }
        deckModel.onInspectClassification = { [weak self] in self?.inspectClassification() }
        deckModel.onInspectTasks = { [weak self] in self?.inspectTaskAutopsy() }
        rebuildMenu()
        refresh()
        timer = Timer.scheduledTimer(timeInterval: 20, target: self,
                                     selector: #selector(tick), userInfo: nil, repeats: true)
    }

    func applicationWillTerminate(_ notification: Notification) { timer?.invalidate() }

    func menuWillOpen(_ menu: NSMenu) {
        // Avoid duplicate expensive process probes immediately after the background tick.
        if RefreshPolicy.needsMenuProbe(lastChecked: lastCheck) { refresh() }
    }

    @objc private func tick() { refresh() }

    private func refresh() {
        guard !refreshInFlight else { return }
        refreshInFlight = true
        updateDeck()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let started = ProcessInfo.processInfo.systemUptime
            let fresh = HostProfile.macBook.services.map { self.launchd.probe($0) }
            let elapsedMs = max(0, Int((ProcessInfo.processInfo.systemUptime - started) * 1000))
            DispatchQueue.main.async {
                self.refreshInFlight = false
                self.probes = fresh
                self.lastCheck = Date()
                self.lastProbeCycleMilliseconds = elapsedMs
                for probe in fresh {
                    if probe.state == .running { self.lastConfirmedRunning[probe.service.id] = self.lastCheck }
                    if let previous = self.priorStates[probe.service.id], previous != probe.state {
                        self.log(action: "state-change", target: probe.service.id,
                                 outcome: "\(previous.rawValue)-to-\(probe.state.rawValue)")
                    }
                    self.priorStates[probe.service.id] = probe.state
                }
                self.updateDeck()
                self.rebuildMenu()
            }
        }
    }

    private func updateDeck() {
        deckModel.probes = probes
        deckModel.lastChecked = lastCheck
        deckModel.actionInFlight = actionInFlight
        deckModel.refreshInFlight = refreshInFlight
        deckModel.logFull = logFull
        deckModel.incidents = ledger.recent(limit: 12)
        deckModel.lastConfirmedRunning = lastConfirmedRunning
        deckModel.probeCycleMs = lastProbeCycleMilliseconds
    }

    private func log(action: String, target: String, outcome: String) {
        if !ledger.record(action: action, target: target, outcome: outcome) { logFull = true }
        updateDeck()
    }

    private func item(_ title: String, action: Selector? = nil, enabled: Bool = true,
                      key: String = "") -> NSMenuItem {
        let result = NSMenuItem(title: title, action: action, keyEquivalent: key)
        result.target = self
        result.isEnabled = enabled
        return result
    }

    /// White means required daemon liveness is confirmed; red means degraded or unknown.
    /// Coordinator admission, owner permission, and task effects are separate diagnostics.
    private func makeStatusIcon(for health: SystemHealth) -> NSImage {
        let tone = StatusIndicatorTone.forHealth(health)
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { _ in
            let shield = NSBezierPath()
            shield.move(to: NSPoint(x: 9, y: 17))
            shield.curve(to: NSPoint(x: 15.5, y: 14.5),
                         controlPoint1: NSPoint(x: 11.4, y: 16.7),
                         controlPoint2: NSPoint(x: 13.7, y: 15.1))
            shield.line(to: NSPoint(x: 15.5, y: 9))
            shield.curve(to: NSPoint(x: 9, y: 1),
                         controlPoint1: NSPoint(x: 15.5, y: 5.1),
                         controlPoint2: NSPoint(x: 11.9, y: 1.8))
            shield.curve(to: NSPoint(x: 2.5, y: 9),
                         controlPoint1: NSPoint(x: 6.1, y: 1.8),
                         controlPoint2: NSPoint(x: 2.5, y: 5.1))
            shield.line(to: NSPoint(x: 2.5, y: 14.5))
            shield.curve(to: NSPoint(x: 9, y: 17),
                         controlPoint1: NSPoint(x: 4.3, y: 15.1),
                         controlPoint2: NSPoint(x: 6.6, y: 16.7))
            shield.close()
            (tone == .white ? NSColor.white : NSColor.systemRed).setFill()
            shield.fill()
            if tone == .red {
                NSColor.white.setFill()
                NSBezierPath(roundedRect: NSRect(x: 8.2, y: 7.2, width: 1.6, height: 5.5),
                             xRadius: 0.8, yRadius: 0.8).fill()
                NSBezierPath(ovalIn: NSRect(x: 8.2, y: 4.4, width: 1.6, height: 1.6)).fill()
            }
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = tone == .white
            ? "DEX Panic: required services running"
            : "DEX Panic: required service health requires attention"
        return image
    }

    private func rebuildMenu() {
        menu.removeAllItems()
        let health = HealthClassifier.classify(probes)
        let statusText: String
        switch health {
        case .healthy: statusText = "Services running (capacity unknown)"
        case .degraded: statusText = "Degraded"
        case .unknown: statusText = "Unknown / checking"
        }
        menu.addItem(item("DEX//PANIC  •  \(statusText)", enabled: false))
        if let lastCheck {
            menu.addItem(item("Checked \(DateFormatter.localizedString(from: lastCheck, dateStyle: .none, timeStyle: .medium))", enabled: false))
        }
        if logFull { menu.addItem(item("Incident log unavailable or at size limit", enabled: false)) }
        menu.addItem(.separator())
        menu.addItem(item("Open Recovery Deck...", action: #selector(openRecoveryDeck)))
        menu.addItem(item("Copy share-safe diagnostic report", action: #selector(copyDiagnostics)))
        menu.addItem(item("Refresh local health", action: #selector(manualRefresh), enabled: !refreshInFlight))
        menu.addItem(item("Show owner access status", action: #selector(showOwnerStatus), enabled: !actionInFlight))
        menu.addItem(item("Inspect coordinator capacity (read-only)", action: #selector(showWorkStatus), enabled: !actionInFlight))
        menu.addItem(item("Inspect competing work (MacBook + Big Mac, read-only)", action: #selector(inspectCompetingWork), enabled: !deckModel.inspectingWork))
        menu.addItem(item("Inspect coordinator classifications (read-only)", action: #selector(inspectClassification), enabled: !deckModel.inspectingClassification))
        menu.addItem(item("Inspect durable task states (read-only)", action: #selector(inspectTaskAutopsy), enabled: !deckModel.inspectingTasks))
        menu.addItem(.separator())
        menu.addItem(item("STOP NEW REMOTE AI EXECUTION", action: #selector(disableRemoteAI), enabled: !actionInFlight))
        menu.addItem(item("Does not terminate already-running tasks", enabled: false))
        menu.addItem(.separator())
        for service in ServiceRegistry.reach {
            let probe = probes.first { $0.service.id == service.id }
            let state = probe?.state.rawValue ?? "checking"
            let parent = item("\(service.title)  •  \(state)")
            let sub = NSMenu(title: service.title)
            let canStart = probe.map { RecoveryGuard.decide(.startStopped, for: $0) == .allowed } ?? false
            let canRestart = probe.map {
                if case .blocked = RecoveryGuard.decide(.forceRestart, for: $0) { return false }
                return true
            } ?? false
            let start = item("Start stopped service", action: #selector(startService(_:)), enabled: canStart && !actionInFlight)
            start.representedObject = service.id
            sub.addItem(start)
            let restart = item("Restart service (review first)...", action: #selector(restartService(_:)),
                               enabled: canRestart && !actionInFlight)
            restart.representedObject = service.id
            sub.addItem(restart)
            sub.addItem(.separator())
            sub.addItem(item(probe?.detail ?? "Not checked", enabled: false))
            menu.setSubmenu(sub, for: parent)
            menu.addItem(parent)
        }
        menu.addItem(.separator())
        menu.addItem(item("Open Stinky Weasel Control (if running)", action: #selector(openDashboard)))
        menu.addItem(item("Show incident log in Finder", action: #selector(revealLog)))
        menu.addItem(item("Hermes / Ollama: planned, not controlled", enabled: false))
        menu.addItem(.separator())
        menu.addItem(item("Quit DEX//PANIC", action: #selector(quit)))

        // An explicitly colored, non-template image avoids macOS menu-bar tint overrides.
        statusItem.button?.image = makeStatusIcon(for: health)
        statusItem.button?.contentTintColor = nil
        switch health {
        case .healthy:
            statusItem.button?.toolTip = "DEX//PANIC: required services running; capacity/authority not checked"
        case .degraded:
            statusItem.button?.toolTip = "DEX//PANIC: a required service is stopped or missing"
        case .unknown:
            statusItem.button?.toolTip = "DEX//PANIC: local launchctl checks unverified; open Recovery Deck for guidance"
        }
    }

    /// Owner-initiated, read-only process inspection. No DEX task mutation, no process kill.
    @objc private func inspectCompetingWork() {
        guard !deckModel.inspectingWork else { return }
        openRecoveryDeck()
        deckModel.inspectingWork = true
        deckModel.selectedWorkHost = .macBook
        deckModel.workSnapshots = [:]
        rebuildMenu()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let inspector = CompetingWorkInspector(runner: self.runner)
            let local = inspector.inspectMacBook()
            DispatchQueue.main.async { [weak self] in
                self?.deckModel.workSnapshots[.macBook] = local
            }
            let remote = inspector.inspectBigMac()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.deckModel.workSnapshots[.bigMac] = remote
                self.deckModel.inspectingWork = false
                self.rebuildMenu()
            }
        }
    }

    /// Owner-triggered coordinator evidence, no process or task mutation.
    @objc private func inspectClassification() {
        guard !deckModel.inspectingClassification else { return }
        openRecoveryDeck()
        let target = deckModel.selectedWorkHost
        deckModel.inspectingClassification = true
        rebuildMenu()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let sample = OwnerEvidenceInspector(runner: self.runner, profile: .macBook).attribution(host: target)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.deckModel.classifiedWork[target] = sample
                self.deckModel.inspectingClassification = false
                self.rebuildMenu()
            }
        }
    }

    /// Task autopsy can only observe current durable metadata; it NEVER resumes or retries.
    @objc private func inspectTaskAutopsy() {
        guard !deckModel.inspectingTasks else { return }
        openRecoveryDeck()
        let target = deckModel.selectedWorkHost
        deckModel.inspectingTasks = true
        rebuildMenu()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let sample = OwnerEvidenceInspector(runner: self.runner, profile: .macBook).autopsy(host: target)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.deckModel.taskAutopsies[target] = sample
                self.deckModel.inspectingTasks = false
                self.rebuildMenu()
            }
        }
    }

    @objc private func manualRefresh() { refresh() }

    /// Clipboard is the ONLY output destination. Never include raw owner CLI output or files.
    @objc private func copyDiagnostics() {
        let report = DiagnosticReport.render(DiagnosticSnapshot(
            probes: probes, services: HostProfile.macBook.services,
            lastConfirmedRunning: lastConfirmedRunning,
            cycleDurationMilliseconds: lastProbeCycleMilliseconds,
            lastChecked: lastCheck, refreshInFlight: refreshInFlight,
            admissionNote: deckModel.capacityNote, admissionChecked: deckModel.capacityChecked,
            workEvidence: deckModel.capacityEvidence, workSnapshots: deckModel.workSnapshots,
            classifiedWork: deckModel.classifiedWork, taskAutopsies: deckModel.taskAutopsies,
            authorityNote: deckModel.authorityNote, authorityChecked: deckModel.authorityChecked,
            logFull: logFull, incidents: ledger.recent(limit: 24)))
        let clipboard = NSPasteboard.general
        clipboard.clearContents()
        if clipboard.setString(report, forType: .string) {
            deckModel.copyFeedback = "Diagnostic report copied. Paste it into ChatGPT; review before sharing."
        } else {
            deckModel.copyFeedback = "Clipboard unavailable. No report was shared."
        }
    }

    private func alert(title: String, text: String, warning: Bool = false) {
        let panel = NSAlert()
        panel.messageText = title
        panel.informativeText = text
        panel.alertStyle = warning ? .warning : .informational
        panel.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        panel.runModal()
    }

    private func confirm(title: String, text: String, action: String) -> Bool {
        let panel = NSAlert()
        panel.messageText = title
        panel.informativeText = text
        panel.alertStyle = .warning
        panel.addButton(withTitle: action)
        panel.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        return panel.runModal() == .alertFirstButtonReturn
    }

    private func doAction(name: String, target: String, perform: @escaping () -> CommandResult) {
        guard !actionInFlight else { return }
        actionInFlight = true
        updateDeck()
        rebuildMenu()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let outcome = perform()
            DispatchQueue.main.async {
                guard let self else { return }
                self.actionInFlight = false
                self.updateDeck()
                self.log(action: name, target: target, outcome: outcome.outcomeLabel)
                // A returned exit 0 is not proof that the intended service or policy is healthy.
                if name == "Disable remote execution" {
                    self.deckModel.authorityNote = outcome.succeeded ? "OFF VERIFIED" : "OFF NOT VERIFIED"
                    self.deckModel.authorityChecked = Date()
                }
                let suffix: String
                if name == "Disable remote execution" && outcome.succeeded {
                    suffix = "A separate owner-local status readback confirmed AI access OFF. Existing processes and uncertain task effects were not stopped or changed."
                } else if outcome.succeeded {
                    suffix = "The command returned successfully. Health will be checked again; task outcomes are not inferred from a service exit code."
                } else {
                    suffix = "No recovery is assumed. Inspect owner status or the underlying service before retrying."
                }
                self.alert(title: "\(name): \(outcome.outcomeLabel)", text: suffix, warning: !outcome.succeeded)
                self.refresh()
            }
        }
    }

    @objc private func disableRemoteAI() {
        doAction(name: "Disable remote execution", target: "node-local-policy") { [cli] in
            let command = cli.disable()
            guard command.succeeded else { return command } // Never retry ambiguous policy mutations.
            let observed = cli.status() // Read-only verification, not a second mutation.
            guard OwnerStatusParser.accessMode(observed) == .off else {
                return CommandResult(exitCode: nil, timedOut: observed.timedOut,
                                     startError: "OFF not confirmed by owner-local status readback")
            }
            return CommandResult(exitCode: 0, timedOut: false, output: "Verified OFF")
        }
    }

    @objc private func showOwnerStatus() {
        guard !actionInFlight else { return }
        actionInFlight = true
        updateDeck()
        rebuildMenu()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let result = self.cli.status()
            DispatchQueue.main.async {
                self.actionInFlight = false
                self.log(action: "read-owner-status", target: "node-local-policy", outcome: result.outcomeLabel)
                self.deckModel.authorityChecked = Date()
                let access = OwnerStatusParser.accessMode(result)
                let explanation: String
                switch access {
                case .off:
                    self.deckModel.authorityNote = "OFF VERIFIED"
                    explanation = "New remote AI execution is blocked by the owner-local policy. Tasks already running are not necessarily stopped."
                case .readOnly:
                    self.deckModel.authorityNote = "READ-ONLY"
                    explanation = "Owner-local policy permits read-only inspection, not new mutations. This is a policy choice, not a service fault."
                case .on:
                    self.deckModel.authorityNote = "ON"
                    explanation = "Owner-local policy permits remote AI work within the configured profile and remaining safety limits. This does not guarantee task admission."
                case .unknown:
                    self.deckModel.authorityNote = "NOT VERIFIED"
                    explanation = "The owner CLI did not return a verifiable policy mode. No policy change is inferred. Try inspection again later or copy the diagnostic report."
                }
                self.alert(title: "DEX//REACH owner policy", text: explanation,
                           warning: access == .unknown)
                self.rebuildMenu()
            }
        }
    }

    @objc private func showWorkStatus() {
        guard !actionInFlight else { return }
        actionInFlight = true
        updateDeck()
        rebuildMenu()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let result = self.cli.workStatus()
            DispatchQueue.main.async {
                self.actionInFlight = false
                self.log(action: "read-work-status", target: "coordinator-capacity", outcome: result.outcomeLabel)
                self.deckModel.capacityChecked = Date()
                let evidence = WorkEvidenceParser.parse(result)
                self.deckModel.capacityEvidence = evidence
                let admission = WorkStatusParser.admission(result)
                let explanation: String
                switch admission {
                case .available:
                    self.deckModel.capacityNote = "AVAILABLE AT CHECK"
                    explanation = "The coordinator had capacity for a new medium job when inspected. This is not permission, and capacity can change."
                case .queued:
                    self.deckModel.capacityNote = "QUEUED AT CHECK"
                    explanation = "The coordinator would queue new work at the last inspection. This usually means competing work or resource pressure, not a confirmed daemon crash. Wait for work to settle before checking again."
                case .unknown:
                    self.deckModel.capacityNote = "NOT VERIFIED"
                    explanation = "The capacity inspection could not be verified. No capacity or outage claim is made."
                }
                let evidenceText: String
                if let evidence {
                    evidenceText = "\n\nObserved memory: \(evidence.memory); CPU: \(evidence.cpu); uncoordinated heavy jobs: \(evidence.uncoordinatedHeavy.map(String.init) ?? "not reported")."
                } else {
                    evidenceText = "\n\nResource pressure details were not available."
                }
                self.alert(title: "DEX//REACH work admission", text: explanation + evidenceText +
                           "\n\nA running process is not proof a task finished. Use Copy diagnostic report to share these sanitized observations.",
                           warning: admission == .unknown)
                self.rebuildMenu()
            }
        }
    }

    private func selectedProbe(_ sender: NSMenuItem) -> ServiceProbe? {
        guard let id = sender.representedObject as? String else { return nil }
        return probes.first { $0.service.id == id }
    }

    @objc private func startService(_ sender: NSMenuItem) {
        guard let probe = selectedProbe(sender), RecoveryGuard.decide(.startStopped, for: probe) == .allowed else {
            alert(title: "Start refused", text: "The service must be positively identified as loaded and stopped.", warning: true)
            return
        }
        doAction(name: "Start stopped service", target: probe.service.id) { [launchd] in launchd.start(probe) }
    }

    @objc private func restartService(_ sender: NSMenuItem) {
        guard let probe = selectedProbe(sender) else { return }
        let decision = RecoveryGuard.decide(.forceRestart, for: probe)
        if case .blocked(let reason) = decision {
            alert(title: "Restart refused", text: reason, warning: true)
            return
        }
        let active = probe.state == .running
        if active {
            let allowed = confirm(title: "Restart \(probe.service.title)?",
                text: "This may interrupt a live DEX task. A disconnected response is not proof an operation stopped. The app will not replay tasks, change permissions, clear state, or choose another node. Continue only if you accept the risk of an ambiguous in-flight effect.",
                action: "Restart this service")
            if !allowed { return }
        }
        doAction(name: active ? "Confirmed service restart" : "Start stopped service",
                 target: probe.service.id) { [launchd] in launchd.restart(probe, ownerConfirmed: active) }
    }

    @objc private func openRecoveryDeck() {
        if deckWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 925, height: 780),
                                  styleMask: [.titled, .closable, .resizable, .miniaturizable],
                                  backing: .buffered, defer: false)
            window.title = "DEX//PANIC / Recovery Deck"
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.isReleasedWhenClosed = false
            window.minSize = NSSize(width: 680, height: 560)
            window.contentView = NSHostingView(rootView: RecoveryDeckView(model: deckModel))
            window.center()
            deckWindow = window
        }
        updateDeck()
        deckWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func openDashboard() {
        guard let url = URL(string: "http://127.0.0.1:4177") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func revealLog() {
        guard FileManager.default.fileExists(atPath: ledger.logURL.path) else {
            alert(title: "No incident log yet", text: "An incident record appears after the first action or service state change.")
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([ledger.logURL])
    }

    @objc private func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = DEXPanicMenuBar()
app.delegate = delegate
app.run()
#else
import Foundation
print("DEX//PANIC menu-bar interface requires macOS. Run RecoveryCore tests on this platform.")
#endif
