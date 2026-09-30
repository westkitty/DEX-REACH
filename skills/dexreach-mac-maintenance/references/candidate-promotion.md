# Candidate Promotion Gate

Use this only when a report-only or newly discovered path is being considered for future automatic maintenance policy.

A name containing `cache`, `tmp`, `staging`, `backup`, `old`, or `previous` is evidence to investigate, not permission to delete.

## Required proof sequence

Before promoting a path into `AUTO_SAFE` or `SAFE_COSTLY`, establish all applicable points:

1. **Exact scope** - identify the narrowest directory or bounded child pattern. Never promote a broad parent because one child was safe.
2. **Semantic role** - show that the target is cache, staging, generated output, downloadable runtime material, or equivalent rebuildable debris rather than source/config/session/user state.
3. **Reconstruction path** - identify how the owner recreates the material. Network redownload or rebuild cost must be declared.
4. **Configuration references** - prove current configuration does not point at the candidate when a local path can be configured as live state.
5. **Live-use state** - use owner-process checks or exact open-handle checks. A failed live-use check is `BLOCKED`, not clear.
6. **Protected siblings** - state the adjacent paths that must remain untouched.
7. **Apply-time revalidation** - rerun volatile checks immediately before mutation.
8. **Regression fixture** - add a test proving the exact safe path can be removed and the protected neighbor cannot.

## Disposition

- `AUTO_SAFE`: cheap, unambiguous cache/state that rebuilds automatically and has robust live-use guards.
- `SAFE_COSTLY`: rebuildable, but redownload/rebuild/plugin refresh can be expensive or surprising.
- `REPORT_ONLY`: evidence is incomplete or the owner semantics are not stable enough for automatic cleanup.
- `PROTECTED`: configuration, source, session/history, credential, current runtime, canonical data, unique backup, or any target whose live/rebuild state cannot be proven.

## Learned protected examples

Do not promote these based only on size/location:

- `~/.cache/codex-runtimes` current primary runtime;
- `~/.rustup` active/default Rust toolchain;
- DexDictate/FluidAudio models;
- DexDictate deployment backups without explicit retention/restorability policy;
- OpenRouter `.tmp` parents containing configured live marketplace paths;
- whole `~/.cache`, `~/Library/Caches`, `~/Library/Application Support`, `.gemini`, `.codex`, `.local`, or `.vscode` parents.
