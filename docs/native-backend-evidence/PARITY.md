# Big Mac native backend replacement — final candidate evidence

VERDICT: PASS within the candidate source and isolated runtime scope below. No deployment or installed-runtime acceptance.

This is the prepublication verification snapshot. Its HEAD/commit/push statements describe that snapshot; subsequent publication is established by Git history and the remote ref.

Target: bigmac / Darwin arm64 / /Users/bigmac/DEX-REACH-bigmac-hub-candidate. Branch main; base and unchanged HEAD 274ba16e058e2b1e855a8ae4a5c30ad63ea81363; origin https://github.com/westkitty/DEX-REACH.git.

Production source now selects NativeCompatibilityAdapter. Root production dependencies declare the native libraries directly, Desktop Commander 0.2.52 is development-only, and security/audit-exceptions.json is empty. A clean production-only install contains no Desktop Commander package and reports zero vulnerabilities. This is not a dependency-free or clean-room claim.

## 22-tool parity matrix

Each PASS applies to recorded cases, not every possible input. S = exact frozen schema; B/O/E = successful behavior, normalized outputs, selected malformed/missing/refusal cases. Error N/A means a parameterless inspection tool with authorization refusal tested separately. A = real node executor OFF and missing-grant cases for all 22, plus representative READ-ONLY, roots, revocation, timed access and ceilings. L = applicable isolated handle/resource/cleanup tests described below.

Implementations: H = maintained MIT-derived handler behind DEX admission/bounds; P = DEX Markdown renderer plus MIT-derived PDF transformation/parser; R = maintained shell/process handlers plus DEX virtual execution and process-group lifecycle; Q = MIT-derived ripgrep search plus DEX resource/lifecycle management.

| Tool | S | B/O/E | A | L | Implementation | Evidence |
|---|---|---|---|---|---|---|
| get_config | PASS | PASS / PASS / N/A | PASS | PASS recorded cases | H | parity.json + executor/functional/resource tests |
| read_file | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | H | parity.json + executor/functional/resource tests |
| read_multiple_files | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | H | parity.json + executor/functional/resource tests |
| write_file | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | H | parity.json + executor/functional/resource tests |
| write_pdf | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | P | parity.json + executor/functional/resource tests |
| create_directory | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | H | parity.json + executor/functional/resource tests |
| list_directory | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | H | parity.json + executor/functional/resource tests |
| move_file | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | H | parity.json + executor/functional/resource tests |
| start_search | PASS | PASS / PASS (async) / PASS | PASS | PASS recorded cases | Q | parity.json + executor/functional/resource tests |
| get_more_search_results | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | Q | parity.json + executor/functional/resource tests |
| stop_search | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | Q | parity.json + executor/functional/resource tests |
| list_searches | PASS | PASS / PASS / N/A | PASS | PASS recorded cases | Q | parity.json + executor/functional/resource tests |
| get_file_info | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | H | parity.json + executor/functional/resource tests |
| edit_block | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | H | parity.json + executor/functional/resource tests |
| start_process | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | R | parity.json + executor/functional/resource tests |
| read_process_output | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | R | parity.json + executor/functional/resource tests |
| interact_with_process | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | R | parity.json + executor/functional/resource tests |
| force_terminate | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | R | parity.json + executor/functional/resource tests |
| list_sessions | PASS | PASS / PASS / N/A | PASS | PASS recorded cases | R | parity.json + executor/functional/resource tests |
| list_processes | PASS | PASS / PASS / N/A | PASS | PASS recorded cases | R | parity.json + executor/functional/resource tests |
| kill_process | PASS | PASS / PASS / PASS | PASS | PASS recorded cases | R | parity.json + executor/functional/resource tests |
| get_usage_stats | PASS | PASS / PASS / N/A | PASS | PASS recorded cases | H | parity.json + executor/functional/resource tests |

The frozen test fixture remains SHA-256 1d10d5b9b43b0f7ab0d83be849c5ade4bb9f4bc93067d9b1376197d2a4d740b8. The latest differential uses the actual incumbent index with isolated HOME/config, telemetry off, existing browser cache, refused loopback feature-flag URL, and HTTP listeners constrained to loopback. No startup paths are omitted and no browser is downloaded. Candidate code is a clean standalone package.

Normalization retains data/structured shape while removing fixture paths, PIDs/search IDs, timestamps, config identity and volatile counters/system data. start_search initial result counts are scheduler-dependent; stable admission fields and the completed get_more_search_results continuation match. Both initial snapshots remain in parity.json. Inherited text errors with isError=false (for example malformed PDF) are preserved and explicitly classified.

## Functional and security observations

- All 22 schemas and successful output contracts pass. Selected errors/refusals pass; no harness assertion failures.
- Files: Unicode/spaces, CRLF/UTF-16 BOM, read paging, write/append, concurrent append, move, metadata, partial multi-read, missing/malformed/permission errors, traversal/symlinks and applicable per-tool out-of-root refusal. Outside sentinel files and denied-move sources remain unchanged.
- Formats: DOCX/XLSX write/read with independent ZIP/XML inspection; PNG write/read with independent macOS sips reopening; real PDF page deletion and Markdown generation on both backends with independent Apple PDFKit reopening/text checks. Native PDF read and bounded URL-PDF read also pass.
- Renderer security: executable/output-path options refused; frontmatter does not configure execution/output. JavaScript, HTTP image/CSS/iframe/navigation and local-file fixture resource attempts do not fetch the sentinel or reveal its text.
- Reads/replies: 16 MiB local metadata admission and URL body limits; 2 MiB replies. Oversized process text truncates while preserving the session handle. Whole-file/large-line/URL budget refusals pass.
- Processes: stable session IDs, stdout/stderr and delayed output, exit7, interactive input, repeated/invalid termination, large-output pagination, session concurrency, SIGTERM/EOF and owned descendant cleanup. Virtual Node execution no longer writes temporary code into the package; success/flood/timeout/cap, parent-success unref descendant, TERM-resistant timeout/force and EOF cleanup pass.
- Search: initial/continued/empty/large results, invalid handles, concurrent admission cap, retained result count/byte bounds, actual active FIFO cancellation on both backends, cleanup, and actual five-minute completed-session expiry. Expiry rows measured about 310 seconds, not clock-simulated.
- Authorization: the real node executor and real registry/coordinator enforce OFF, READ-ONLY, missing grants, roots, revoked grants/node, client ceilings, timed access, owner-local refusal, no node fallback and durable task completion. The compiled production-default node passes the same checks from the clean production install.
- Independent static review identified and drove admission, log-buffer and descendant-cleanup repairs; final reviewed integration has no outstanding Critical/Important findings. Review does not substitute for the measured tests above.

## Matched performance

Three alternating rounds, 100 identical bounded reads per backend per round, with actual incumbent startup under the isolated configuration described above. These are local fixture observations, not live workload or universal speed guarantees.

| Backend | Median connect ms | Median read p95 ms | Median final RSS KiB | Requests | Child exit checks |
|---|---:|---:|---:|---:|---|
| incumbent | 320.58 | 18.29 | 162832 | 300 | PASS |
| candidate | 265.00 | 0.69 | 137696 | 300 | PASS |

## Final checks and artifact identity

- Post-switch full suite: 973/973 passed, 0 failed, 0 skipped, 207755.10 ms. Historical tests were not weakened: exact historical object fetching repaired the shallow-clone assumptions.
- Typecheck PASS; 42/42 invariants PASS; build PASS including the reviewed runtime inventory; diff/syntax checks PASS.
- Raw production audit and audit gate PASS with zero vulnerabilities and zero exceptions. Full development installs still retain the vulnerable incumbent solely for differential reference.
- Clean production-only npm ci --omit=dev --ignore-scripts installed 254 packages. The compiled native probe verifies all 22 schemas, an isolated read, implementation/source hash, and owner-local refusal. No Desktop Commander package is physically present.
- Compiled default node integration from /tmp/DEX-native-production-clean-20261026 PASS. Source and clean artifact main/adapter byte hashes match (checks.json). No alternate backend fallback exists.
- Upgrade/rollback machinery and fixtures remain intact and pass in the full suite. No stage/activate/rollback command was executed.

## Preservation, live state and limits

Live PID 54439 remains /opt/homebrew/bin/node /Users/bigmac/DEX-REACH/dist/src/node/main.js, with the original Oct25 start time. Live version was not reattested; 0.3.2 is the prior observation. No service, credential, grants, policy, roots or ~/.dex-reach owner state was changed.

Original checkpoint bfaac955e5a1316782ba560779c500f59fe0e9c43121fa0dc58e984ef3584acc and the additional continuation checkpoint 2e67e944d7055a16f707496c16c18b089e13aa0c0391fcb22785cd2515cc2cc0 were preserved and rehashed. Paths and source hashes are in checks.json. No archive restore was executed. Existing unrelated dirty/untracked work was preserved; no reset, stash, clean, mass-stage, branch/HEAD change, commit or push.

Application limits are not an operating-system sandbox. Local-read size admission uses metadata before handlers read; this is not a hard OS quota against a separately authorized process changing files. Format/container checks are scoped to the fixtures stated above, not independent Office GUI or human visual acceptance. No live/physical chaos, installed-runtime proof or human acceptance is claimed.

Source-only. No installation, activation, service restart, deployment or publication. Any live upgrade remains separately gated.
