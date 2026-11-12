import Foundation

public enum RefreshPolicy {
    /// The 20-second timer remains the authoritative periodic probe. Opening the
    /// menu inside this freshness window should not duplicate four launchctl calls.
    /// Explicit manual refresh is never throttled, and unknown/future timestamps
    /// are treated as stale rather than assumed healthy.
    public static func needsMenuProbe(lastChecked: Date?, now: Date = Date(),
                                      freshnessSeconds: TimeInterval = 8) -> Bool {
        guard let lastChecked else { return true }
        let age = now.timeIntervalSince(lastChecked)
        return age < 0 || age >= max(1, freshnessSeconds)
    }
}
