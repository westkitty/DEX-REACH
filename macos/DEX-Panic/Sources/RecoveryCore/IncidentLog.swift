import Foundation

public struct IncidentRecord: Codable {
    public let timestamp: String
    public let action: String
    public let target: String
    public let outcome: String

    public init(timestamp: String, action: String, target: String, outcome: String) {
        self.timestamp = timestamp
        self.action = action
        self.target = target
        self.outcome = outcome
    }
}

public final class IncidentLog {
    public let logURL: URL
    private let maxBytes: UInt64 = 2 * 1024 * 1024
    private let lock = NSLock()

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.logURL = home.appendingPathComponent("Library/Logs/DEX-Panic", isDirectory: true)
            .appendingPathComponent("events.jsonl")
    }

    @discardableResult
    public func record(action: String, target: String, outcome: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let fm = FileManager.default
        let folder = logURL.deletingLastPathComponent()
        do {
            try fm.createDirectory(at: folder, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
            let length = (try? fm.attributesOfItem(atPath: logURL.path)[.size] as? NSNumber)?.uint64Value ?? 0
            let record = IncidentRecord(timestamp: ISO8601DateFormatter().string(from: Date()),
                                        action: action, target: target, outcome: outcome)
            var payload = try JSONEncoder().encode(record)
            payload.append(0x0a)
            // Never exceed the advertised cap or delete incident evidence silently.
            guard UInt64(payload.count) <= maxBytes,
                  length <= maxBytes - UInt64(payload.count) else { return false }
            if (try? logURL.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
                return false // Refuse to follow a redirected event file.
            }
            if !fm.fileExists(atPath: logURL.path) {
                guard fm.createFile(atPath: logURL.path, contents: nil,
                                    attributes: [.posixPermissions: 0o600]) else { return false }
            }
            let handle = try FileHandle(forWritingTo: logURL)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: payload)
            try handle.synchronize()
            return true
        } catch {
            return false
        }
    }

    /// A bounded owner-local event tail; never read arbitrary-size logs into the UI.
    public func recent(limit: Int = 18) -> [IncidentRecord] {
        lock.lock()
        defer { lock.unlock() }
        guard limit > 0, FileManager.default.fileExists(atPath: logURL.path),
              (try? logURL.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) != true,
              let handle = try? FileHandle(forReadingFrom: logURL) else { return [] }
        defer { try? handle.close() }
        do {
            let length = try handle.seekToEnd()
            let window: UInt64 = 96 * 1024
            let offset = length > window ? length - window : 0
            try handle.seek(toOffset: offset)
            let data = try handle.read(upToCount: Int(min(window, length - offset))) ?? Data()
            var lines = String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true)
            // The first line is potentially truncated when seeking into an existing log.
            if offset > 0 && !lines.isEmpty { lines.removeFirst() }
            let selected = lines.suffix(min(limit, 40))
            return selected.compactMap { try? JSONDecoder().decode(IncidentRecord.self, from: Data($0.utf8)) }
        } catch {
            return []
        }
    }
}
