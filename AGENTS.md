# DEX//REACH Project Instructions

Canonical repository: https://github.com/westkitty/DEX-REACH

Treat DEX//REACH as one persistent project across conversations, agents, machines, and work sessions. A new chat is not a new project. Recover current state from the repository before acting; do not rebuild context from memory.

## Authority

Use this order when sources disagree:
1. The user's newest explicit instruction.
2. The live `westkitty/DEX-REACH` repository on the active branch.
3. `OPERATIONAL_STATE.md` for verified, broken, unverified, unknown, and pending state.
4. `README.md` for architecture, purpose, setup, and human-facing operation.
5. Current source, tests, scripts, `SECURITY.md`, and docs.
6. Git history when needed to reconstruct intent.
7. Prior chat/model claims only as leads.

Never let stale conversation memory override repository evidence. Source presence is not proof that a behavior works.

## Session Start

Before substantive work:
- identify the exact requested outcome;
- inspect branch/repository state;
- read `README.md` and `OPERATIONAL_STATE.md` before consequential code, architecture, deployment, security, routing, auth, installer, or policy work;
- inspect only the relevant implementation/tests first, broadening search only when evidence requires it;
- recover referenced prior work from repository state, Git history, operational state, or runtime evidence instead of asking the user to repeat facts already available.

## Purpose

DEX//REACH is a secure AI-native remote-computing control plane. Its purpose is not merely remote command execution. It provides useful AI access while preserving device-owner authority, machine-specific scope, revocability, auditability, and fail-closed behavior.

Preserve the established architecture unless evidence shows a change is necessary.

## Protected Invariants

Preserve the active invariants in `OPERATIONAL_STATE.md`, especially:
- the node is the final authority;
- every remote operation is explicitly scoped to a `node_id`;
- blank, unknown, offline, disabled, or revoked nodes fail; never fall back to another machine;
- node-local `off` / `read-only` / `on`, timed access, and per-client ceilings are enforced before execution;
- missing/corrupt policy fails closed; newly enrolled nodes start OFF;
- allowed-root restrictions apply to native and compatibility operations;
- node credentials are independent and revocable;
- public source access grants no runtime authority;
- gateway/node credentials, enrollment files, tokens, policies, and deployment secrets stay outside Git and public output;
- only the authenticated gateway may be intentionally exposed; never expose raw shell/node listeners publicly;
- never silently widen roots, permissions, or execution profiles to make a task pass;
- do not convert simulation evidence into physical-hardware verification.

Do not print or request secret values unless a narrowly justified credential-recovery task explicitly requires them.

## Using DEX//REACH

For real remote-machine work:
1. list/discover nodes;
2. select the exact intended `node_id`;
3. fingerprint before environment-sensitive or consequential mutation when execution identity matters;
4. respect the node's current access mode, client ceiling, profile, and allowed roots;
5. perform only the authorized operation;
6. inspect the returned evidence.

A node-local refusal is a boundary, not an obstacle to bypass. Do not claim an operation ran unless execution evidence shows it ran.

Prefer using available DEX//REACH capabilities for authorized work over merely telling the user to run equivalent commands manually.

## Change Discipline

For implementation work:
- preserve verified behavior;
- make the smallest cohesive change that fully satisfies the request;
- reuse existing architecture and conventions;
- avoid unrelated rewrites, cleanup, dependency replacement, or rescaffolding;
- inspect the changed-file set before completion;
- preserve unrelated user changes;
- never force-push, destructively reset/clean Git, erase unrelated work, disable security controls to pass validation, fabricate credentials, or falsify evidence.

Commit, push, publish, deploy, install, revoke credentials, or mutate external state only when that class of action is authorized.

## Validation

Use repository-provided checks. Escalate according to impact:
1. affected static/type/schema checks;
2. focused tests;
3. relevant integration/runtime checks;
4. build;
5. broader regression suite when warranted;
6. public MCP/smoke validation when the changed path requires it.

Primary quality gate when applicable:

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
npm run probe:backend
npm run smoke
```

Do not rerun expensive broad checks after an earlier decisive failure until that failure is repaired. Never report tests, deployment, installation, or runtime behavior that was not actually observed.

## Persistent macOS Deployment

The primary verified macOS deployment may already run gateway/node as `launchd` services. Before starting manual `npm run gateway` or `npm run node` processes, inspect current runtime/service state and `npm run dex -- status` so duplicate processes are not launched accidentally.

Use manual processes for deliberate development/diagnosis and installed services for the persistent deployment. Do not confuse source state, build state, installed state, active runtime, or public route state.

## Second Devices

Treat each second device as an independent security boundary. Enrollment creates a credential; installation places it on a machine; neither grants AI execution. The device owner separately chooses OFF, READ-ONLY, ON, timed windows, and client ceilings.

Transfer enrollment files only through a private channel. Never put them in Git, issues, PRs, docs, prompts, or ordinary chat.

## Operational State

Durable project truth belongs in the repository, not hidden chat memory. After a meaningful verified change, update affected tests/docs and patch `OPERATIONAL_STATE.md` when the actual project state changed.

Keep states distinct: `verified`, `implemented-unverified`, `known-broken`, `unknown`, `pending`, `superseded`. Do not mark work verified merely because code exists or a narrow check passes.

A future agent should be able to resume from the repository plus `OPERATIONAL_STATE.md` without this conversation.

## Completion

Do not call a task complete because code exists. Completion requires evidence appropriate to the requested user outcome.

Report compactly:
- what changed or was established;
- files/systems affected;
- validation actually performed and results;
- commit/push/deploy/install state when relevant;
- anything unresolved, unverified, or intentionally untouched.

Default operating principle: retrieve before guessing; fingerprint before consequential remote execution; preserve local authority; fail closed; protect secrets; verify claims; record durable state; do not make the next session rediscover the project from scratch.
