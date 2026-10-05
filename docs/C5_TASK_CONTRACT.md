# C5 durable-task contract

This source revision keeps the original 16 public MCP tools unchanged and adds one
explicit lifecycle multiplexer, `reach_task`, for a total of 17 advertised tools.
The existing direct tools remain synchronous; no fast operation was silently
converted to asynchronous execution.

`reach_list_nodes` reports optional node capabilities. A current node advertises
`durable_tasks: true`; a legacy v1 node omits that field and is treated as
capability-absent. `reach_task` requires an exact `node_id` and supports only the
implemented actions `start`, `get`, `result`, and `cancel`.

For `start`, `mode: durable` refuses with `CAPABILITY_UNSUPPORTED_ON_NODE` when
the selected node does not advertise durable tasks. `mode: auto` performs an
explicit synchronous result fallback on such a node and labels the result
`synchronous-fallback`; it never returns a fake task handle. A capable node
creates and persists the local TaskStore record before returning its handle.

Every lifecycle request is routed to the exact node. The node binds control to
the original actor identity, checks current owner policy, and reads or changes
only the matching task. Results are read through the node's persisted result
reference and hash verification. Rich local states remain visible as
`reachState`; the public `status` is the MCP-compatible projection:

| Local state | Public status |
| --- | --- |
| `ACCEPTED`, `PREPARING`, `RUNNING` | `working` |
| `INPUT_REQUIRED` | `input_required` |
| `COMPLETED` | `completed` |
| `FAILED`, `AMBIGUOUS`, `RECONCILED` | `failed` |
| `CANCELLED` | `cancelled` |

The installed SDK exposes experimental MCP Tasks, but the current ChatGPT
connector does not provide native task capability proof in this campaign. This
revision therefore verifies the durable backend and explicit fallback lifecycle
only; it does not claim native MCP Tasks acceptance or refresh the connector.
