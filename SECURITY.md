# Security Policy

## Supported code

DEX//REACH is currently pre-1.0. Security fixes target the current `main` branch. There are no separately supported release lines yet.

## Report a vulnerability privately

Do **not** open a public issue, discussion, or pull request containing exploitable details, credentials, tokens, private paths, or sensitive logs.

Use GitHub's **Security** tab for this repository and choose **Report a vulnerability** to start a private report. If that option is unavailable, contact the maintainer through the [westkitty GitHub profile](https://github.com/westkitty) and request a private reporting channel before sending technical details.

Include only what is needed to reproduce and assess the issue:

- affected commit or version;
- affected component (gateway, OAuth/MCP, node transport, local policy, installer, audit, native executor, or compatibility adapter);
- prerequisites and realistic impact;
- minimal reproduction steps or proof of concept;
- whether credentials or personal data may have been exposed;
- suggested mitigation, if known.

Redact live secrets and personal data. Do not test against infrastructure, gateways, nodes, or accounts you do not own or have explicit permission to assess.

## What belongs in a public issue

Public issues are appropriate for non-sensitive hardening ideas, documentation errors, and defects that do not reveal a usable bypass or confidential deployment information. When uncertain, report privately first.

## Security boundaries that must remain intact

A fix must preserve DEX//REACH's core trust model:

- the node is the final authority and enforces `off`, `read-only`, `on`, timed windows, per-client caps, and capability grants locally before execution;
- missing or corrupt node policy fails closed, and a newly enrolled node starts `off`;
- every operation names an explicit `node_id`; blank, unknown, offline, disabled, or revoked nodes fail and there is no default target or fallback;
- typed filesystem operations, checkpoints, read-only process arguments, and compatibility-tool path arguments are constrained to configured allowed roots;
- scope checks canonicalize existing symlinks and inspect singular, plural, nested, snake_case, and camelCase path-bearing compatibility arguments before execution;
- DEX private state under `~/.dex-reach/` or `DEX_REACH_STATE_DIR` is excluded from path-scoped remote operations even if a broader allowed root contains it; relative path arguments fail closed;
- READ-ONLY native process execution is shell-free and compatibility execution uses an explicit inspection-tool allowlist; unknown compatibility tools fail closed;
- compatibility safety configuration is node-owned. Remote clients cannot change `allowedDirectories`/telemetry configuration, recover Desktop Commander call history, invoke vendor feedback/onboarding surfaces, or use compatibility URL-fetch mode;
- ON-mode arbitrary shell execution is a high-authority capability: allowed roots constrain its working directory but are **not** an OS filesystem sandbox for arbitrary shell programs. Child processes nevertheless do not inherit DEX credential variables or obvious secret-bearing environment variables, and known parent secret values are redacted from returned stdout/stderr;
- node-local secret values are never resolved outside the node and never leave it: the model names aliases only, values are read from the node's own 0600 store after final authorization and immediately before a local invocation, injected into one child process's environment rather than onto a command line, and kept out of plans, audit entries, receipts, traces, checkpoints, share reports and Git. `secret.use` is an independent capability that no other capability implies, an operation that cannot inject a named alias refuses the request rather than running without it, and READ-ONLY and workspace-safe refuse injection outright. Output scrubbing is best effort against a command that echoes a value and is not a boundary against one that transforms or forwards it;
- capability grants can only narrow authority. They cannot override OFF, READ-ONLY, a stricter client ceiling, or configured node roots;
- exact-action plans bind the node, client, operation/arguments, policy hash, fresh execution fingerprint, expiry, and one-use state; optional caller-supplied expected-identity fields must match before planning, commit rechecks the stored execution identity before mutation, concurrent claims admit at most one executor, and raw plan arguments are scrubbed after claim or expiry;
- execution receipts are node-local Ed25519-signed records containing hashes rather than raw request/result contents and are appended as one predecessor-linked chain;
- bootstrap, owner-policy, grant-use, plan-claim, receipt-chain, node-auth, revocation, and OAuth persistence use atomic or locked state transitions where concurrent writers could otherwise weaken authority or corrupt state;
- nodes connect outbound and do not expose a raw shell listener;
- a non-loopback public MCP identity must use HTTPS; a node may use `ws://` only to loopback and must use `wss://` for a remote gateway;
- node credentials are independent and revocable;
- public source access grants no gateway, OAuth-client, node, or filesystem authority;
- credentials, enrollment files, tokens, private keys, policies, and sensitive file contents do not enter Git, public documentation, or the redacted audit trail;
- persistent-service installation and convenience launchers may restore already-installed services but must not silently widen access mode, client ceilings, capability grants, credentials, roots, profiles, or trust boundaries;
- live trust reports are evidence-scoped: a PASS means only the listed runtime checks passed and never substitutes for full regression, deployment, hardware, or hosted-CI proof;
- simulation evidence is never represented as proof of separate physical hardware.

Public visibility of this repository is not a security boundary. Authentication, explicit enrollment, least authority, local policy, revocation, and runtime proof are.

## Important limitation of ON/full-local shell access

`reach_process_run` in an enabled high-authority profile intentionally permits a bounded shell command. DEX removes credential-bearing environment variables, blocks direct DEX-private-state targeting, applies command guardrails, and constrains the requested working directory, but it is **not** a kernel/VM filesystem sandbox. A program started by the device owner's user account may have whatever filesystem access that operating-system account has.

Use OFF/READ-ONLY, capability grants, narrower node profiles, narrower OS permissions, separate accounts, containers/VMs, or other OS isolation when that distinction matters. Do not advertise DEX allowed roots as equivalent to mandatory OS confinement for arbitrary ON-mode shell programs.

## Response and disclosure

The maintainer will acknowledge reports when practical, investigate against the current code, and coordinate remediation and disclosure according to severity and available evidence. Please allow time for a fix before publishing details.
