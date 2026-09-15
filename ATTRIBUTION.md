# Attribution and upstream boundaries

DEX//REACH uses `@wonderwhy-er/desktop-commander` 0.2.50 as an initial local compatibility adapter under its MIT license.

DEX//REACH does not copy, reconstruct, or depend on the proprietary hosted Remote Desktop Commander relay.

The adapter boundary is deliberate: DEX//REACH owns authorization, remote routing, node identity, safety policy, audit, output bounding, checkpoints, native bridges, and the remote MCP endpoint. A future native local executor can replace the compatibility adapter without changing the gateway protocol.
