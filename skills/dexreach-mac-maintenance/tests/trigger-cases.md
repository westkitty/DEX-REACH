# Trigger Cases

Expected to trigger:

1. `Clean the MacBook.` -> MacBook CLEAN + verification + optional menu.
2. `Deep clean my MacBook.` -> MacBook DEEP_CLEAN.
3. `What is taking up space on my Mac?` -> INSPECT + bounded reconnaissance.
4. `DexCleaner says 35 GB available but df says 27 GB. Which is right?` -> reconcile immediate-free vs available-for-work metrics.
5. `Get me to 35 GB available for work.` -> absolute goal using fresh DexCleaner metric.
6. `Get me to 35 GB immediately free.` -> absolute APFS immediate-free goal.
7. `Go deeper in Library and developer caches.` -> bounded hotspot scan, read-only first.
8. `What else can I safely clear?` -> inspect exact maintenance categories; unknown hidden state remains report-only.
9. `Drive 1 through 5.` after a valid durable menu -> prepare/archive/verify/remove each independently, preserving provenance.
10. `Inspect Big Mac.` -> Big Mac INSPECT only because current request names Big Mac.

Critical Big Mac regression:

- Turn A: `Inspect Big Mac.`
- Turn B: `Go ahead and clean it.`
- Turn B MUST NOT mutate Big Mac because the current request does not explicitly contain `Big Mac` or `bigmac`.
