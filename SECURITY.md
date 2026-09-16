# Security Policy

## Supported code

DEX//REACH is currently pre-1.0. Security fixes target the current `main` branch. There are no separately supported release lines yet.

## Report a vulnerability privately

Do **not** open a public issue, discussion, or pull request containing exploitable details, credentials, tokens, private paths, or sensitive logs.

Use GitHub's **Security** tab for this repository and choose **Report a vulnerability** to start a private report. If that option is unavailable, contact the maintainer through the [westkitty GitHub profile](https://github.com/westkitty) and request a private reporting channel before sending technical details.

Include only what is needed to reproduce and assess the issue:

- affected commit or version;
- affected component (gateway, OAuth/MCP, node transport, local policy, installer, audit, or compatibility adapter);
- prerequisites and realistic impact;
- minimal reproduction steps or proof of concept;
- whether credentials or personal data may have been exposed;
- suggested mitigation, if known.

Redact live secrets and personal data. Do not test against infrastructure, gateways, nodes, or accounts you do not own or have explicit permission to assess.

## What belongs in a public issue

Public issues are appropriate for non-sensitive hardening ideas, documentation errors, and defects that do not reveal a usable bypass or confidential deployment information. When uncertain, report privately first.

## Security boundaries that must remain intact

A fix must preserve DEX//REACH's core trust model:

- the node is the final authority and enforces `off`, `read-only`, `on`, timed windows, and per-client caps locally;
- missing or corrupt node policy fails closed;
- every operation names an explicit `node_id`; there is no default target or fallback;
- allowed roots and command guardrails are enforced on the node;
- nodes connect outbound and do not expose a raw shell listener;
- node credentials are independent and revocable;
- public source access grants no gateway, OAuth-client, or node authority;
- credentials, enrollment files, tokens, and sensitive file contents do not enter Git or audit logs.

Public visibility of this repository is not a security boundary. Authentication, explicit enrollment, least authority, local policy, and revocation are.

## Response and disclosure

The maintainer will acknowledge reports when practical, investigate against the current code, and coordinate remediation and disclosure according to severity and available evidence. Please allow time for a fix before publishing details.
