# DEX native compatibility backend provenance

The filesystem, search, process, document and image handlers derive from the
MIT-licensed Desktop Commander 0.2.52 distribution. Preserve LICENSE. This is a
maintained derivative, not a clean-room implementation.

DEX-maintained replacements include the frozen 22-tool dispatcher, stdio boundary,
telemetry/raw-log stubs, bounded local/URL reads and replies, Markdown PDF renderer,
virtual Node execution, admission/resource controls, and process-group cleanup.
The PDF renderer uses only an already installed Chromium-compatible browser in a
temporary profile, disables scripts and external resources, and accepts bounded
PDF layout options. It does not interpret frontmatter as configuration.

package.json and package-lock.json declare and pin this backend's own dependencies.
runtime-files.json is the reviewed build inventory; source-hashes.json is generated
by scripts/package-native-backend.mjs. No Desktop Commander package is required by
the standalone backend. Source runtime/node_modules from earlier experiments is
not copied into build artifacts and is not portability evidence.

The shared adapter catalog retains its historical desktop-commander authority key.
The implementation identity is @dex-reach/native-backend; this does not widen any
tool, capability, root, profile, grant, budget, or plan authority. DEX's real node
executor remains the authorization authority.

Resource envelope: 16 MiB aggregate local-read metadata admission, 16 MiB URL body,
2 MiB replies (process text truncation preserves its identity), 16 shell sessions,
16 virtual sessions/four virtual executions, 1000 search results/4 MiB retained per
search/16 searches. These are application limits, not an operating-system sandbox.
See docs/native-backend-evidence/PARITY.md for measured coverage and limitations.
