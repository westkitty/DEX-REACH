# Intent Contract

## Target binding

- MacBook is the only implicit/default target.
- Every Big Mac action requires the literal current user request to contain `Big Mac` or `bigmac`.
- Never inherit Big Mac authority from prior context, pronouns, online-node state, or recent work.

## Mode binding

| User wording | Mode |
|---|---|
| check, inspect, health check, what is taking space | `INSPECT` |
| clean the MacBook, run maintenance, clean my Mac | `CLEAN` |
| deep clean the MacBook | `DEEP_CLEAN` |
| clean stale test processes, performance cleanup | `PERFORMANCE` |
| reclaim/delete another N GB | goal-bounded `CLEAN` using amount-to-reclaim |
| get me to N GB free | absolute goal; bind storage metric first |
| what else can I clear, show large files, storage hogs | `INSPECT` plus optional menu |

Never let recursion or a previous mode grant a stronger mode.

## Absolute storage goals

Read [storage-metrics.md](storage-metrics.md).

- `N GB immediately free` -> `immediately-free`.
- `N GB available for work`, or a target explicitly tied to DexCleaner -> `available-for-work`.
- If `free` is ambiguous and choosing the metric could materially change deletion, clarify or present both before mutation.
- An `available-for-work` goal requires a fresh DexCleaner sample. If unavailable, block that metric rather than substituting immediate free silently.
- Stop planning when the requested metric is already at/above the goal.

## Numbered optional-menu binding

A menu number means only what the exact run and `menu_sha256` say it means.

- Bare maintenance numbers authorize only the exact non-active maintenance entries selected.
- Bare durable numbers never delete.
- Require `remove <n>` or `drive <n>` for durable items.
- Mixed durable/maintenance selections do not mutate until every durable action is explicit.
- Never guess stale numbers against a regenerated menu.
- When a partial archive/removal changes the next menu numbering, report both the original menu provenance and the fresh number for remaining items.

## Storage reconnaissance

Default reconnaissance is bounded to Downloads, Movies, Desktop, Documents, Music and Pictures.

- Report files at/above the large-file threshold and qualifying old installers/archives.
- Show exact relative names for selectable durable candidates.
- Do not inspect hidden application data file-by-file by default.
- `~/Library` hotspots are aggregate evidence only until dedicated inspection is requested.
- For a deep hidden-space scan, use the bundled bounded hotspot helper and [candidate-promotion.md](candidate-promotion.md); never launch an uncontrolled whole-home `du` crawl.

## Durable-removal binding

Automatic maintenance never removes durable user content.

For a durable menu item:

1. revalidate menu hash and exact metadata;
2. prepare a durable ticket with original menu provenance;
3. apply only the current-request action;
4. if Drive was selected, require a verified receipt before local removal;
5. if anything changed, regenerate instead of guessing.
