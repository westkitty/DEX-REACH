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
    private var logFull = false
    private let deckModel = RecoveryDeckModel()
    private var deckWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "shield.lefthalf.filled",
                                           accessibilityDescription: "DEX Panic recovery controls")
        statusItem.button?.toolTip = "DEX//PANIC: checking local services"
        menu.delegate = self
        statusItem.menu = menu
        deckModel.onRefresh = { [weak self] in self?.refresh() }
        deckModel.onDisable = { [weak self] in self?.disableRemoteAI() }
        deckModel.onCapacity = { [weak self] in self?.showWorkStatus() }
        deckModel.onAuthority = { [weak self] in self?.showOwnerStatus() }
        deckModel.onOpenLog = { [weak self] in self?.revealLog() }
        rebuildMenu()
        refresh()
        timer = Timer.scheduledTimer(timeInterval: 20, target: self,
                                     selector: #selector(tick), userInfo: nil, repeats: true)
    }

    func applicationWillTerminate(_ notification: Notification) { timer?.invalidate() }

    func menuWillOpen(_ menu: NSMenu) {
        refresh()
    }

    @objc private func tick() { refresh() }

    private func refresh() {
        guard !refreshInFlight else { return }
        refreshInFlight = true
        updateDeck()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let fresh = ServiceRegistry.reach.map { self.launchd.probe($0) }
            DispatchQueue.main.async {
                self.refreshInFlight = false
                self.probes = fresh
                self.lastCheck = Date()
                for probe in fresh {
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
        menu.addItem(item("Refresh local health", action: #selector(manualRefresh), enabled: !refreshInFlight))
        menu.addItem(item("Show owner access status", action: #selector(showOwnerStatus), enabled: !actionInFlight))
        menu.addItem(item("Inspect coordinator capacity (read-only)", action: #selector(showWorkStatus), enabled: !actionInFlight))
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

        if health == .degraded {
            statusItem.button?.contentTintColor = .systemOrange
            statusItem.button?.toolTip = "DEX//PANIC: one or more required services stopped"
        } else if health == .healthy {
            statusItem.button?.contentTintColor = .systemGreen
            statusItem.button?.toolTip = "DEX//PANIC: services running; resource admission not checked"
        } else {
            statusItem.button?.contentTintColor = .secondaryLabelColor
            statusItem.button?.toolTip = "DEX//PANIC: service health unknown"
        }
    }

    @objc private func manualRefresh() { refresh() }

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
                switch OwnerStatusParser.accessMode(result) {
                case .off: self.deckModel.authorityNote = "OFF VERIFIED"
                case .readOnly: self.deckModel.authorityNote = "READ-ONLY"
                case .on: self.deckModel.authorityNote = "ON"
                case .unknown: self.deckModel.authorityNote = "NOT VERIFIED"
                }
                let localText = result.succeeded ? String(result.output.prefix(5000)) : result.outcomeLabel
                self.alert(title: "DEX//REACH owner status", text: localText.isEmpty ? "No status text returned" : localText,
                           warning: !result.succeeded)
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
                switch WorkStatusParser.admission(result) {
                case .available: self.deckModel.capacityNote = "AVAILABLE AT CHECK"
                case .queued: self.deckModel.capacityNote = "QUEUED AT CHECK"
                case .unknown: self.deckModel.capacityNote = "NOT VERIFIED"
                }
                let localText = result.succeeded ? String(result.output.prefix(5000)) : result.outcomeLabel
                self.alert(title: "DEX//REACH coordinator admission",
                           text: (localText.isEmpty ? "No status returned" : localText) +
                                 "\n\nService liveness and admission capacity are separate. A saturated coordinator can refuse work even while all daemons are running.",
                           warning: !result.succeeded)
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
