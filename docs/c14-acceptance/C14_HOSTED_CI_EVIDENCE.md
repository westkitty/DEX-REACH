# C14 hosted CI evidence

## Exact revision and trigger

- Repository: `westkitty/DEX-REACH`
- Draft PR: [#16](https://github.com/westkitty/DEX-REACH/pull/16)
- Base: `c13-worker-repair`
- Head branch: `c14-chaos-recovery`
- Source candidate SHA: `ab1cf13ae2ce38b5916410b2e8c72cea71ddf848`
- Current documentation head SHA: `07cd89b74b9a14b6d3bd50397aa4bc3871fd8b77`
- Event: `pull_request`
- PR state: OPEN, DRAFT, not merged

The workflow checks were triggered through the authorized draft PR because the
standalone branch has no configured push trigger. The workflows checked out
the PR head revision; this is not a main-branch or installed-runtime result.

## Runs

| Workflow | Run ID | Jobs | Conclusion |
| --- | ---: | --- | --- |
| DEX validation | `38024779749` | `validate` `114133195189`; `reproducible-build` `114133195349`; `runtime-proof` `114133195425` | PASS |
| CodeQL | `38024779741` | `analyze` `114133195320` | PASS |

Current-head confirmation (documentation-only commits after the source candidate):

| DEX validation | `38024937682` | `validate` `114133669095`; `reproducible-build` `114133669218`; `runtime-proof` `114133669262` | PASS |
| CodeQL | `38024937603` | `analyze` `114133668922` | PASS |

The validation job passed npm installation, typecheck, 42 invariants, the full
385-test suite, build, and production audit. Reproducible-build passed the
clean-build comparison. Runtime-proof passed the required loopback gateway/node
proof. CodeQL analysis passed with no reported failure.

## Boundary

These runs establish hosted source validation for the PR head. They do not
prove the MacBook installed runtime, launchd behavior, physical chaos, public
connector refresh, DEX product conformance, or human acceptance. PR #16 must
not be merged automatically; PR #15 remains separate and unchanged.

Later bookkeeping commits may change documentation only; no production source
changed after this exact-head validation.
