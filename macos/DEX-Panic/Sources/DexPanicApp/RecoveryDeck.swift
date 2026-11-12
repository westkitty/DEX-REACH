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

    var onRefresh: (() -> Void)?
    var onDisable: (() -> Void)?
    var onCapacity: (() -> Void)?
    var onAuthority: (() -> Void)?
    var onOpenLog: (() -> Void)?

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
                    serviceGrid
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
                truthCell("SERVICES", detail: model.health == .healthy ? "Liveness observed" : "Fault / unknown", accent: signalColor)
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

    private var serviceGrid: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("02 / SUPERVISED COMPONENTS")
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

    private var recoveryControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("03 / OWNER CONTROLS")
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
                sectionLabel("04 / BLACK BOX EVENTS")
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
            Text("DEX//PANIC 0.2 / INTERNAL")
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
