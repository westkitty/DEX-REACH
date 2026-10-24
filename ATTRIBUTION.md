# Attribution and upstream boundaries

DEX//REACH uses `@wonderwhy-er/desktop-commander` 0.2.50 as an initial local compatibility adapter under its MIT license.

DEX//REACH does not copy, reconstruct, or depend on the proprietary hosted Remote Desktop Commander relay.

The adapter boundary is deliberate: DEX//REACH owns authorization, remote routing, node identity, safety policy, audit, output bounding, checkpoints, native bridges, and the remote MCP endpoint. A future native local executor can replace the compatibility adapter without changing the gateway protocol.

The adapter's nested `zod@3.25.76` carries GHSA-mrhx-c7xc-m3w5 (high), which has no fix compatible with the adapter. For 0.4.0 the owner approved a narrow, expiring audit exception for exactly that node. It is an exception, not a fix, and it is retired by the native replacement of this adapter. See [docs/security/AUDIT_EXCEPTIONS.md](docs/security/AUDIT_EXCEPTIONS.md).
