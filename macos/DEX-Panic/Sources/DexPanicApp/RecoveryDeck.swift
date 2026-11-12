#if os(macOS)
import AppKit
import SwiftUI
import RecoveryCore

/// Owner-local presentation state. It does not own execution, credentials or task truth.
final class RecoveryDeckModel: ObservableObject {
    @Published var probes: [ServiceProbe] = []
    @Published var lastChecked: Date?
    @Published var incidents: [IncidentRecord] = []
    @Published var actionInFlight = false
    @Published var refreshInFlight = false
    @Published var logFull = false
    @Published var capacityNote = "NOT INSPECTED"
    @Published var authorityNote = "NOT INSPECTED"
    @Published var capacityChecked: Date?
    @Published var capacityEvidence: WorkEvidence?
    @Published var authorityChecked: Date?
    @Published var copyFeedback = ""
    @Published var workSnapshots: [WorkHost: WorkHostSnapshot] = [:]
    @Published var selectedWorkHost: WorkHost = .macBook
    @Published var inspectingWork = false
    @Published var classifiedWork: [WorkHost: ClassifiedWorkSnapshot] = [:]
    @Published var taskAutopsies: [WorkHost: TaskAutopsySnapshot] = [:]
    @Published var inspectingClassification = false
    @Published var inspectingTasks = false
    @Published var lastConfirmedRunning: [String: Date] = [:]
    @Published var probeCycleMs: Int?

    var onRefresh: (() -> Void)?
    var onDisable: (() -> Void)?
    var onCapacity: (() -> Void)?
    var onAuthority: (() -> Void)?
    var onOpenLog: (() -> Void)?
    var onCopyDiagnostics: (() -> Void)?
    var onInspectCompetingWork: (() -> Void)?
    var onInspectClassification: (() -> Void)?
    var onInspectTasks: (() -> Void)?
    var finding: DiagnosticFinding { ProbeExplanation.assess(probes, services: ServiceRegistry.reach) }

    var health: SystemHealth { HealthClassifier.classify(probes) }
    var headline: String {
        switch health {
        case .healthy: return "DAEMONS RUNNING"
        case .degraded: return "REQUIRED SERVICE STOPPED"
        case .unknown: return "INSUFFICIENT SIGNAL"
        }
    }
    var guidance: String {
        switch health {
        case .healthy:
            return "Service liveness is observed. Admission, task progress and owner policy are separate checks."
        case .degraded:
            return "At least one required service is stopped or not loaded. Check its state before a targeted start."
        case .unknown:
            return "A required service is unreadable or missing from this snapshot. Never force a restart on an unknown state."
        }
    }
}

private enum DeckInk {
    static let midnight = Color(red: 0.055, green: 0.071, blue: 0.084)
    static let panel = Color(red: 0.105, green: 0.128, blue: 0.141)
    static let panelBorder = Color(red: 0.19, green: 0.235, blue: 0.247)
    static let bone = Color(red: 0.94, green: 0.92, blue: 0.86)
    static let muted = Color(red: 0.65, green: 0.69, blue: 0.68)
    static let aqua = Color(red: 0.50, green: 0.85, blue: 0.78)
    static let warning = Color(red: 1.0, green: 0.72, blue: 0.36)
    static let danger = Color(red: 0.98, green: 0.39, blue: 0.34)
}

struct RecoveryDeckView: View {
    @ObservedObject var model: RecoveryDeckModel

    private let grid = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ZStack {
            DeckInk.midnight.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header
                    divider
                    systemTruth
                    diagnosticHelp
                    serviceGrid
                    competingWork
                    coordinatorClassifications
                    taskAutopsy
                    recoveryControls
                    flightRecorder
                    footer
                }
                .padding(.horizontal, 30)
                .padding(.top, 32)
                .padding(.bottom, 36)
                .frame(maxWidth: 1040)
                .frame(maxWidth: .infinity)
            }
        }
        .preferredColorScheme(.dark)
        .frame(minWidth: 650, minHeight: 540)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 24) {
            VStack(alignment: .leading, spacing: 6) {
                Text("STINKY WEASEL / LOCAL AUTHORITY")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .tracking(2.5).foregroundColor(DeckInk.aqua)
                Text("DEX//PANIC")
                    .font(.system(size: 44, weight: .black, design: .monospaced))
                    .tracking(-2).foregroundColor(DeckInk.bone)
                    .accessibilityAddTraits(.isHeader)
                Text("RECOVERY DECK  /  FLIGHT RECORDER")
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .tracking(1.2).foregroundColor(DeckInk.muted)
            }
            Spacer(minLength: 12)
            VStack(alignment: .trailing, spacing: 7) {
                HStack(spacing: 7) {
                    Circle().fill(signalColor).frame(width: 9, height: 9)
                    Text(model.headline)
                        .font(.system(size: 12, weight: .bold, design: .monospaced))
                        .foregroundColor(signalColor)
                }
                Text(model.lastChecked.map { "Last probe: \($0.formatted(date: .omitted, time: .standard))" }
                     ?? "No probe recorded")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(DeckInk.muted)
                Button(action: { model.onRefresh?() }) {
                    Label(model.refreshInFlight ? "Checking..." : "Run fresh checks", systemImage: "arrow.clockwise")
                }
                .buttonStyle(DeckSecondaryButton())
                .disabled(model.refreshInFlight)
            }
        }
    }

    private var divider: some View {
        Rectangle().fill(DeckInk.panelBorder).frame(height: 1).accessibilityHidden(true)
    }

    private var signalColor: Color {
        switch model.health {
        case .healthy: return DeckInk.aqua
        case .degraded: return DeckInk.danger
        case .unknown: return DeckInk.warning
        }
    }

    private var systemTruth: some View {
        VStack(alignment: .leading, spacing: 11) {
            sectionLabel("01 / SYSTEM TRUTH")
            Text(model.guidance)
                .font(.system(size: 14, weight: .regular))
                .foregroundColor(DeckInk.bone)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                truthCell("SERVICES", detail: model.health == .healthy ? "Required daemons running" : (model.health == .unknown ? "Check incomplete" : "Confirmed fault"), accent: signalColor)
                truthCell("ADMISSION", detail: model.capacityNote,
                          accent: model.capacityNote.hasPrefix("AVAILABLE") ? DeckInk.aqua : DeckInk.warning)
                truthCell("OWNER POLICY", detail: model.authorityNote, accent: DeckInk.warning)
                truthCell("TASK EFFECTS", detail: "NOT VERIFIED", accent: DeckInk.warning)
            }
        }
    }

    private func truthCell(_ title: String, detail: String, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title).font(.system(size: 10, weight: .bold, design: .monospaced))
                .tracking(1.4).foregroundColor(DeckInk.muted)
            HStack(alignment: .top, spacing: 5) {
                Rectangle().fill(accent).frame(width: 3, height: 22)
                Text(detail).font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundColor(DeckInk.bone).lineLimit(3)
            }
            Spacer(minLength: 0)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading).frame(height: 93)
        .background(DeckInk.panel, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(DeckInk.panelBorder, lineWidth: 1))
    }

    /// A read-only interpretation followed by a copyable, strictly bounded evidence snapshot.
    private var diagnosticHelp: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                sectionLabel("02 / WHAT THE CHECK FOUND")
                Spacer(minLength: 8)
                Button(action: { model.onCopyDiagnostics?() }) {
                    Label("Copy diagnostic report", systemImage: "doc.on.doc")
                }
                .buttonStyle(DeckSecondaryButton())
                .accessibilityHint("Copies only allowlisted, share-safe service observations and recent event metadata")
            }
            VStack(alignment: .leading, spacing: 11) {
                HStack(spacing: 9) {
                    Image(systemName: model.finding.kind == "liveness" ? "checkmark.shield" : "stethoscope")
                        .foregroundColor(model.health == .healthy ? DeckInk.aqua : DeckInk.warning)
                        .accessibilityHidden(true)
                    Text(model.finding.title)
                        .font(.system(size: 17, weight: .bold))
                        .foregroundColor(DeckInk.bone)
                        .accessibilityAddTraits(.isHeader)
                }
                Text(model.finding.meaning)
                    .font(.system(size: 13))
                    .foregroundColor(DeckInk.bone)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 9) {
                    Text("Check cycle: \(model.probeCycleMs.map { "\($0) ms" } ?? "not measured")")
                    Text("4s deadline per service")
                }
                .font(.system(size: 10, design: .monospaced)).foregroundColor(DeckInk.muted)
                Text("Last positive liveness is retained separately for each service; a timeout is not proof the daemon stopped.")
                    .font(.system(size: 11)).foregroundColor(DeckInk.muted)
                Divider().overlay(DeckInk.panelBorder)
                Text("WHAT YOU CAN DO SAFELY")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundColor(DeckInk.aqua)
                Text(model.finding.nextStep)
                    .font(.system(size: 13))
                    .foregroundColor(DeckInk.bone)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Button(action: { model.onRefresh?() }) {
                        Label(model.refreshInFlight ? "Checking..." : "Try checks again", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(DeckSecondaryButton())
                    .disabled(model.refreshInFlight)
                    Button(action: { model.onCapacity?() }) {
                        Label("Inspect capacity", systemImage: "chart.bar.xaxis")
                    }
                    .buttonStyle(DeckSecondaryButton())
                    .disabled(model.actionInFlight)
                }
                if model.capacityNote == "QUEUED AT CHECK" {
                    Text("Capacity was queued at the last inspection. That can explain delayed work, but does not prove any daemon stopped. The result may be stale.")
                        .font(.system(size: 12)).foregroundColor(DeckInk.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let evidence = model.capacityEvidence {
                    Text("Last capacity sample: memory \(evidence.memory), CPU \(evidence.cpu), \(evidence.uncoordinatedHeavy.map(String.init) ?? "unknown") uncoordinated heavy jobs. This is historical read-only evidence, not a live health guarantee.")
                        .font(.system(size: 12))
                        .foregroundColor(DeckInk.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !model.copyFeedback.isEmpty {
                    Text(model.copyFeedback)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(DeckInk.aqua)
                        .accessibilityLabel(model.copyFeedback)
                }
                Text("Copied reports exclude credentials, private paths, raw CLI output and full audit logs. Nothing is restarted or disabled by copying.")
                    .font(.system(size: 11)).foregroundColor(DeckInk.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(DeckInk.panel, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(DeckInk.panelBorder, lineWidth: 1))
        }
    }

    private var serviceGrid: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("03 / SUPERVISED COMPONENTS")
            LazyVGrid(columns: grid, spacing: 12) {
                ForEach(ServiceRegistry.reach) { service in
                    let state = model.probes.first(where: { $0.service.id == service.id })?.state ?? .unknown
                    let detail = model.probes.first(where: { $0.service.id == service.id })?.detail ?? "Not yet observed"
                    HStack(spacing: 14) {
                        Image(systemName: icon(for: state))
                            .font(.system(size: 20, weight: .light))
                            .foregroundColor(color(for: state)).frame(width: 30)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(service.title.uppercased())
                                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                                .foregroundColor(DeckInk.bone)
                            Text(detail)
                                .font(.system(size: 11)).foregroundColor(DeckInk.muted)
                            if let sampledMs = model.probes.first(where: { $0.service.id == service.id })?.durationMilliseconds {
                                Text("Probe \(sampledMs) ms · last positive \(model.lastConfirmedRunning[service.id]?.formatted(date: .omitted, time: .standard) ?? "not recorded")")
                                    .font(.system(size: 10, design: .monospaced)).foregroundColor(DeckInk.muted)
                            }
                        }
                        Spacer(minLength: 4)
                        Text(state.rawValue.uppercased())
                            .font(.system(size: 9, weight: .semibold, design: .monospaced))
                            .foregroundColor(color(for: state))
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, minHeight: 72)
                    .background(DeckInk.panel, in: RoundedRectangle(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(DeckInk.panelBorder, lineWidth: 1))
                    .accessibilityElement(children: .combine)
                }
            }
            Text("These are local launchd observations. A running daemon may still be unable to accept work.")
                .font(.system(size: 11)).foregroundColor(DeckInk.muted)
        }
    }

    private var competingWork: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                sectionLabel("04 / COMPETING WORK")
                Spacer(minLength: 8)
                Button(action: { model.onInspectCompetingWork?() }) {
                    Label(model.inspectingWork ? "Inspecting..." : "Inspect competing work", systemImage: "cpu")
                }
                .buttonStyle(DeckSecondaryButton())
                .disabled(model.inspectingWork)
                .accessibilityHint("Runs read-only on-demand process samples on MacBook and authenticated Big Mac; never terminates processes")
            }
            Picker("Machine", selection: $model.selectedWorkHost) {
                Text("MacBook Air").tag(WorkHost.macBook)
                Text("Big Mac").tag(WorkHost.bigMac)
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("Machine to inspect")

            if let snap = model.workSnapshots[model.selectedWorkHost] {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 10) {
                        Circle().fill(snap.status == .observed ? DeckInk.aqua : DeckInk.warning)
                            .frame(width: 8, height: 8).accessibilityHidden(true)
                        Text(snap.status == .observed ? "SAMPLE OBSERVED" :
                             (snap.status == .partial ? "PARTIAL SAMPLE" : "UNAVAILABLE"))
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundColor(snap.status == .observed ? DeckInk.aqua : DeckInk.warning)
                        Spacer(minLength: 4)
                        Text(snap.sampledAt.formatted(date: .omitted, time: .standard))
                            .font(.system(size: 11, design: .monospaced)).foregroundColor(DeckInk.muted)
                    }
                    Text(snap.explanation)
                        .font(.system(size: 12)).foregroundColor(DeckInk.bone)
                        .fixedSize(horizontal: false, vertical: true)
                    if snap.processes.isEmpty {
                        Text("No validated process rows to show. This does NOT mean the machine is idle.")
                            .font(.system(size: 12)).foregroundColor(DeckInk.warning)
                    } else {
                        ForEach(snap.processes) { process in
                            processRow(process)
                        }
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(DeckInk.panel, in: RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(DeckInk.panelBorder, lineWidth: 1))
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.inspectingWork ? "Reading process samples..." : "No inspection performed yet")
                        .font(.system(size: 13, weight: .semibold)).foregroundColor(DeckInk.bone)
                    Text("Select Inspect competing work to sample both machines. Big Mac requires the trusted westcat SSH alias and a verified bigmac account/hostname. It is never assumed healthy when unreachable.")
                        .font(.system(size: 12)).foregroundColor(DeckInk.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .background(DeckInk.panel, in: RoundedRectangle(cornerRadius: 9))
            }
            Text("Process names are executable basenames, never command lines. CPU percentages and resident MiB are approximate snapshots. These are candidates, not the coordinator's proven list of uncoordinated jobs. No kill, pause, restart or automatic termination exists in this view.")
                .font(.system(size: 11)).foregroundColor(DeckInk.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func processRow(_ process: WorkProcess) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(process.name)
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .foregroundColor(DeckInk.bone)
                    .lineLimit(2)
                Spacer(minLength: 4)
                Text(String(format: "CPU %.1f%%", process.cpuPercent))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundColor(DeckInk.aqua)
                Text(String(format: "RSS %.0f MiB", process.residentMiB))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(DeckInk.bone)
            }
            Text(process.category.uppercased())
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundColor(DeckInk.aqua)
            Text(process.explanation)
                .font(.system(size: 12)).foregroundColor(DeckInk.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .overlay(alignment: .bottom) { Divider().overlay(DeckInk.panelBorder) }
    }

    /// These grouped classifications come from the coordinator, not from a ps shortlist.
    private var coordinatorClassifications: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                sectionLabel("05 / COORDINATOR ATTRIBUTION")
                Spacer(minLength: 8)
                Button(action: { model.onInspectClassification?() }) {
                    Label(model.inspectingClassification ? "Reading..." : "Inspect classified groups", systemImage: "list.bullet.indent")
                }
                .buttonStyle(DeckSecondaryButton())
                .disabled(model.inspectingClassification)
            }
            if let snap = model.classifiedWork[model.selectedWorkHost] {
                VStack(alignment: .leading, spacing: 9) {
                    HStack {
                        Text("\(model.selectedWorkHost.displayName) · \(snap.state == .observed ? "CLASSIFIED" : "NOT VERIFIED")")
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundColor(snap.state == .observed ? DeckInk.aqua : DeckInk.warning)
                        Spacer()
                        Text(snap.observedAt.formatted(date: .omitted, time: .standard))
                            .font(.system(size: 11, design: .monospaced)).foregroundColor(DeckInk.muted)
                    }
                    Text(snap.explanation).font(.system(size: 12)).foregroundColor(DeckInk.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    if let count = snap.reportedCount {
                        Text("Coordinator reported \(count) uncoordinated group(s) at inspection")
                            .font(.system(size: 12, weight: .medium)).foregroundColor(DeckInk.bone)
                    }
                    if snap.state == .observed && snap.groups.isEmpty {
                        Text("No classified competing groups in this observation. Pressure and task completion remain separate.")
                            .font(.system(size: 12)).foregroundColor(DeckInk.bone)
                    }
                    ForEach(snap.groups) { group in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Text(group.name).font(.system(size: 12, weight: .semibold, design: .monospaced))
                                    .foregroundColor(DeckInk.bone)
                                Spacer()
                                Text("\(group.members) processes · \(group.threshold.uppercased())")
                                    .font(.system(size: 10, design: .monospaced)).foregroundColor(DeckInk.aqua)
                            }
                            Text(String(format: "Group CPU %.1f%% · memory %.1f%%", group.cpuPercent, group.memoryPercent))
                                .font(.system(size: 11, design: .monospaced)).foregroundColor(DeckInk.muted)
                            Text(group.explanation).font(.system(size: 11)).foregroundColor(DeckInk.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.vertical, 7)
                        .overlay(alignment: .bottom) { Divider().overlay(DeckInk.panelBorder) }
                    }
                }
                .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .background(DeckInk.panel, in: RoundedRectangle(cornerRadius: 9))
            } else {
                Text("No coordinator classification inspected for \(model.selectedWorkHost.displayName). Select Inspect classified groups. No automatic action is taken.")
                    .font(.system(size: 12)).foregroundColor(DeckInk.muted)
            }
        }
    }

    /// Read-only task autopsy; uncertain effects can never be promoted to completed by this view.
    private var taskAutopsy: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                sectionLabel("06 / DURABLE TASK AUTOPSY")
                Spacer(minLength: 8)
                Button(action: { model.onInspectTasks?() }) {
                    Label(model.inspectingTasks ? "Reading..." : "Inspect task states", systemImage: "checklist")
                }
                .buttonStyle(DeckSecondaryButton())
                .disabled(model.inspectingTasks)
            }
            if let snap = model.taskAutopsies[model.selectedWorkHost] {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("\(model.selectedWorkHost.displayName) · \(snap.state == .observed ? "READ-ONLY SNAPSHOT" : "INCOMPLETE / UNAVAILABLE")")
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundColor(snap.state == .observed ? DeckInk.aqua : DeckInk.warning)
                        Spacer()
                        Text(snap.observedAt.formatted(date: .omitted, time: .standard))
                            .font(.system(size: 11, design: .monospaced)).foregroundColor(DeckInk.muted)
                    }
                    Text(snap.explanation).font(.system(size: 12)).foregroundColor(DeckInk.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    if snap.state == .observed && snap.tasks.isEmpty {
                        Text("No records returned in this bounded recent-task inspection. This is NOT proof that all effects completed.")
                            .font(.system(size: 12)).foregroundColor(DeckInk.bone)
                    }
                    ForEach(snap.tasks) { task in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Text(task.operation).font(.system(size: 12, weight: .semibold, design: .monospaced))
                                    .foregroundColor(DeckInk.bone)
                                Spacer()
                                Text(task.state).font(.system(size: 10, weight: .semibold, design: .monospaced))
                                    .foregroundColor(["AMBIGUOUS", "INPUT_REQUIRED"].contains(task.state) ? DeckInk.warning : DeckInk.aqua)
                            }
                            Text(task.id).font(.system(size: 10, design: .monospaced)).foregroundColor(DeckInk.muted)
                                .textSelection(.enabled)
                            Text(task.guidance).font(.system(size: 11)).foregroundColor(DeckInk.muted)
                                .fixedSize(horizontal: false, vertical: true)
                            Text("Updated \(task.updatedAt.formatted(date: .abbreviated, time: .shortened)) · Result reference \(task.resultRecorded ? "recorded" : "not recorded")")
                                .font(.system(size: 10, design: .monospaced)).foregroundColor(DeckInk.muted)
                        }
                        .padding(.vertical, 7)
                        .overlay(alignment: .bottom) { Divider().overlay(DeckInk.panelBorder) }
                    }
                }
                .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .background(DeckInk.panel, in: RoundedRectangle(cornerRadius: 9))
            } else {
                Text("No task states inspected for \(model.selectedWorkHost.displayName). Choose Inspect task states. This never retries, resumes or cancels work.")
                    .font(.system(size: 12)).foregroundColor(DeckInk.muted)
            }
            Text("No automatic retry, resume, cancellation or destructive reconciliation is available in this panel.")
                .font(.system(size: 11)).foregroundColor(DeckInk.muted)
        }
    }

    private var recoveryControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("07 / OWNER CONTROLS")
            HStack(spacing: 12) {
                Button(action: { model.onDisable?() }) {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("STOP NEW REMOTE EXECUTION", systemImage: "hand.raised.fill")
                            .font(.system(size: 14, weight: .bold, design: .monospaced))
                        Text("Request local OFF. Does not terminate in-flight work.")
                            .font(.system(size: 11, weight: .regular))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 17).padding(.vertical, 15)
                }
                .buttonStyle(DeckEmergencyButton())
                .disabled(model.actionInFlight)
                .accessibilityHint("Uses the existing node-local owner policy; an OFF state must be verified separately")
            }
            HStack(spacing: 12) {
                Button(action: { model.onCapacity?() }) {
                    Label("Inspect work admission", systemImage: "chart.bar.xaxis")
                }
                .buttonStyle(DeckSecondaryButton())
                .disabled(model.actionInFlight)
                Button(action: { model.onAuthority?() }) {
                    Label("Inspect owner policy", systemImage: "checkmark.shield")
                }
                .buttonStyle(DeckSecondaryButton())
                .disabled(model.actionInFlight)
                Spacer(minLength: 0)
                Text("No automatic restart  /  No blind replay")
                    .font(.system(size: 10, design: .monospaced)).foregroundColor(DeckInk.muted)
            }
        }
    }

    private var flightRecorder: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                sectionLabel("08 / BLACK BOX EVENTS")
                Spacer()
                Button(action: { model.onOpenLog?() }) {
                    Label("Reveal incident file", systemImage: "doc.text.magnifyingglass")
                        .font(.system(size: 11, design: .monospaced))
                }
                .buttonStyle(.plain)
                .foregroundColor(DeckInk.aqua)
            }
            VStack(alignment: .leading, spacing: 0) {
                if model.incidents.isEmpty {
                    Text("No recorded transitions yet. Silence is not evidence of health.")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(DeckInk.muted).padding(18)
                } else {
                    ForEach(Array(model.incidents.indices.reversed()), id: \.self) { index in
                        let record = model.incidents[index]
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(String(record.timestamp.suffix(9)))
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(DeckInk.muted).frame(width: 80, alignment: .leading)
                            Text(record.action)
                                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                .foregroundColor(DeckInk.bone).frame(width: 155, alignment: .leading)
                            Text(record.target)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundColor(DeckInk.aqua).frame(width: 130, alignment: .leading)
                            Text(record.outcome)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundColor(DeckInk.muted)
                                .lineLimit(2)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        Divider().overlay(DeckInk.panelBorder)
                    }
                }
            }
            .background(DeckInk.panel, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(DeckInk.panelBorder, lineWidth: 1))
            if model.logFull {
                Text("Flight recorder cannot append. Preserve/export the existing log before continuing.")
                    .font(.system(size: 11, weight: .semibold)).foregroundColor(DeckInk.warning)
            }
        }
    }

    private var footer: some View {
        HStack {
            Text("LOCAL ONLY  /  NO LISTENER  /  NODE POLICY REMAINS AUTHORITY")
            Spacer()
            Text("DEX//PANIC 0.3.0 / INTERNAL")
        }
        .font(.system(size: 10, weight: .medium, design: .monospaced))
        .foregroundColor(DeckInk.muted)
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title).font(.system(size: 11, weight: .bold, design: .monospaced))
            .tracking(1.7).foregroundColor(DeckInk.aqua)
            .accessibilityAddTraits(.isHeader)
    }

    private func icon(for state: ServiceState) -> String {
        switch state {
        case .running: return "checkmark.circle"
        case .stopped: return "pause.circle"
        case .notInstalled: return "minus.circle"
        case .unknown: return "questionmark.circle"
        }
    }
    private func color(for state: ServiceState) -> Color {
        switch state {
        case .running: return DeckInk.aqua
        case .stopped, .notInstalled: return DeckInk.danger
        case .unknown: return DeckInk.warning
        }
    }
}

private struct DeckSecondaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold, design: .monospaced))
            .foregroundColor(DeckInk.bone)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(configuration.isPressed ? DeckInk.panelBorder : DeckInk.panel,
                        in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(DeckInk.panelBorder, lineWidth: 1))
    }
}

private struct DeckEmergencyButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(DeckInk.midnight)
            .background(configuration.isPressed ? DeckInk.warning : DeckInk.danger,
                        in: RoundedRectangle(cornerRadius: 8))
    }
}
#endif
