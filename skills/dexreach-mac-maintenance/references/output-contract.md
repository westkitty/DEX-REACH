# Output Contract

Keep the visible report compact and distinguish storage quantities explicitly.

```markdown
# DEX//MAINT
Status: CLEAN / PARTIAL / INSPECTION ONLY / BLOCKED
Target: MacBook / Big Mac
Mode: INSPECT / CLEAN / DEEP_CLEAN / PERFORMANCE / GOAL / SELECTED

Storage
- Immediately free: ... GB
- Potentially purgeable: ... GB (only when a fresh source exists)
- Available for work: ... GB (only when a fresh DexCleaner sample exists)
- Goal: ... using <metric>
- Pressure: ...

Applied
- category — measured category delta

Skipped
- category — reason

Durable archive results
- original #8 -> archived/verified -> removed locally
- original #3 -> archive failed -> local original kept -> fresh menu #1

Optional cleanup choices
1. ...
```

Rules:

- Never use the word `available` without saying which quantity it means when multiple metrics are present.
- Keep decimal GB/GiB distinctions explicit when they affect a target comparison.
- Do not equate category-size delta with APFS immediate-free delta or DexCleaner available-for-work delta.
- Report archive timeout/failure and verified remote state separately.
- A Drive archive is complete only with a verified receipt.
- Preserve original durable menu provenance across partial batches; fresh menus may renumber remaining items, but the report must show the mapping.
- Hidden application-data filenames are not exposed during ordinary reconnaissance; exact hidden paths may be shown only during a user-authorized dedicated inspection needed to justify a maintenance candidate.
- Mark active or unverified maintenance entries as blocked rather than inviting deletion.
