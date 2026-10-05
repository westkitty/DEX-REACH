# DEX//REACH Architecture Decisions

This directory contains the authoritative Architecture Decision Records (ADRs) owned by `westkitty/DEX-REACH` under the DEX// 1.0 Control System and DEX//REACH 0.4 Durable Execution program.

## Authoritative Decisions in this Repository

| ADR | Title | Status | Governs |
| :--- | :--- | :--- | :--- |
| [ADR-0001](./0001-durable-task-execution-and-identity.md) | Durable Task Execution and Identity | Accepted | Task authority on node, globally safe ID format, parent/child lineage, actor/node binding, lifecycle state machine, persistence ordering, INPUT_REQUIRED, AMBIGUOUS, and cancellation. |
| [ADR-0002](./0002-operation-safety-retry-and-reconciliation.md) | Operation Safety Classes, Retry Policies, and Reconciliation Semantics | Accepted | Five operation safety classes, idempotency keys, duplicate submissions, retry budgets, uncertainty rules, and mandatory reconciliation protocols. |
| [ADR-0003](./0003-reach-protocol-capability-negotiation.md) | REACH Protocol Capability Negotiation and Legacy Compatibility | Accepted | Protocol v1 vs v2 negotiation, capability headers, no silent downgrade, mixed-version rules, and backward compatibility. |

---

## Companion Architecture Decisions Owned by `westkitty/DEX`

The following companion architecture decisions are authoritatively owned and maintained in `westkitty/DEX` under `docs/architecture/decisions/`:

| ADR in DEX | Title | Version | Cross-Repository Consumer Boundary |
| :--- | :--- | :--- | :--- |
| `ADR-0013` | Canonical 50-Command System, Manifests, and Modifier Monotonicity | `1.0.0` | REACH provides execution transport for command workflows; must enforce modifier monotonicity (`+DRY`, `+PROVE`, `+LOG`). |
| `ADR-0014` | Product Adapter Interface and Ecosystem Boundaries | `1.0.0` | REACH does not depend on or import product internals; interacts solely through versioned product manifests and control interfaces. |
| `ADR-0015` | Control Room Operator Authority and Dashboard Architecture | `1.0.0` | Control Room displays node tasks and issues control signals; REACH node policy remains final execution authority. |
| `ADR-0016` | Provenance Graph and Derived Search Projections | `1.0.0` | REACH emits task execution receipts and causal spans; never indexes unpromoted private data. |
| `ADR-0017` | Ecosystem Control Vocabulary and Lifecycle Actions | `1.0.0` | REACH implements concrete handlers for OPEN, PAUSE, RESUME, RETRY, RECONCILE, CANCEL, CLOSE, RESET, ARCHIVE, DELETE, RESTART, ROLLBACK. |

### Cross-Repository Contract Invariant
Cross-repository contracts expose explicit semantic versions. Consuming components must fail closed with deterministic error payloads upon version mismatch or unsupported capabilities.
