# Techbet Benchmark Report

## Run Metadata

- Date: 2026-02-07 22:26:24 +0800
- Commit: `8c40499`
- Branch: `master`
- Runner: Codex CLI (local macOS)
- Command:
  - `bun run test:benchmark`
- Environment:
  - `LSP_MCP_REQUIRE_BUNDLED_BACKENDS=true`
  - `LSP_MCP_SINGLETON_BACKEND=false` (enabled in `test:benchmark`)

## Overall Summary

- Total tests: 15
- Passed: 15
- Failed: 0
- Total duration: ~27.45s
- Regressions vs previous run:
  - Fixed false failures caused by benchmark-file concurrency against singleton backend locks.
  - Fixed mixed-root TypeScript workspace discovery choosing `vitesse/cypress` instead of `benchmarks/zod`.

## Language Matrix

| Language | Benchmark | Pass Rate | Avg Latency (ms) | Retries | Key Failure Signature |
|---|---|---:|---:|---:|---|
| TypeScript | zod | 5/5 (100%) | ~456.6 | 0 | none |
| Python | fastapi | 6/6 (100%) | ~591.4 | 0 | none |
| Vue | vitesse | 2/2 (100%) | ~7538.1 | 0 | none |

## Mixed-Root Scenario

- Root used: `/Users/treedy/Project/LspMcp/benchmarks`
- Discovery call:
  - `discover_language_workspaces(root='/Users/treedy/Project/LspMcp/benchmarks', apply=true)`
- Suggested mappings:
  - python: `/Users/treedy/Project/LspMcp/benchmarks/fastapi`
  - typescript: `/Users/treedy/Project/LspMcp/benchmarks/zod`
  - vue: `/Users/treedy/Project/LspMcp/benchmarks/vitesse`
- Semantic verification:
  - TypeScript: `hover` pass (~1043.7ms)
  - Python: `hover` pass (~1414.2ms)
  - Vue: `definition` pass (within mixed-root test suite)
- Routing metadata checks:
  - `resolved_language`: pass (typescript/python/vue all correct)
  - `resolved_workspace`: pass (matches mapped language roots)

## Failure Signature Breakdown

| Signature | Count | Severity | First Seen | Affected Area | Suggested Fix |
|---|---:|---|---|---|---|
| `LANGUAGE_WORKSPACE_REQUIRED` | 0 | info | n/a | routing | n/a |
| `VUE_SEMANTIC_DEPS_MISSING` | 0 | info | n/a | deps | n/a |
| `BACKEND_SINGLETON_LOCK_FAILED` | 0 | info | n/a | concurrency | n/a |
| `Invalid or expired cursor` | 0 | info | n/a | paging | n/a |
| Other | 0 | info | n/a | n/a | n/a |

## Doctor Output Review

- `languageCommandChains` complete: yes
- Missing package guidance quality:
  - python: actionable (includes UV cache guidance when needed)
  - typescript: actionable (workspace + hover probe path)
  - vue: actionable (workspace + install command + hover probe path)
- Next-step commands executable as-is: yes (with absolute paths)

## Findings and Actions

### P0
- [x] Standardized strict semantic error fields (`error_code`, `missing_packages`, `install_commands`, `strict_mode`).
- [x] Exposed `resolved_language` / `resolved_workspace` routing metadata on semantic responses.

### P1
- [x] Added `doctor.languageCommandChains` for per-language setup/dependency/repro commands.
- [x] Added mixed-root benchmark matrix test and integrated it into `test:benchmark`.
- [x] Added `doctor.featureCapabilityMatrix.feature_next_steps` with executable per-feature commands for LLM agents.
- [x] Added `semantic_session_start.feature_probe_sequence` to standardize staged semantic probing workflow.
- [x] Added per-step `expected_latency_ms` and `failure_signatures` in `semantic_session_start.feature_probe_sequence` for retry/diagnosis policy.
- [x] Added per-feature `expected_latency_ms` and `failure_signatures` in `doctor.feature_next_steps` for consistent planning metadata.
- [x] Added `lsp_probe_profile` meta tool to expose probe planning metadata directly to clients.
- [x] Defaulted backend runtime strategy to `registry` with explicit `LSP_MCP_BACKEND_RUNTIME_MODE` override (`registry|auto|bundled`).
- [x] Extended `doctor.backendPackageDrift` with latest-version drift fields (`latest_registry_version`, `latest_status`, `latest_next_step`).
- [x] Added `backend_packages.minimum_supported_version` and `doctor.backendPackageDrift.minimum_status` for policy floor checks.
- [x] Added latest registry lookup cache/in-flight dedupe to keep `doctor(check_latest_versions=true)` stable under repeated calls.
- [x] Added `doctor.backendVersionSummary` for compact per-language version triage and lookup statistics.
- [x] Stabilized `backendVersionSummary`/`lookup_stats` schema with explicit `schema_version` and `cache_ttl_ms`.
- [x] Standardized strict semantic responses with `recovery_plan` and cost fields (`latency_ms`, `result_size`, `truncated`, `cursor_available`).
- [x] Added `semantic_navigate` composite tool (search -> definition -> references -> read_file_with_hints) and benchmark coverage.
- [x] Added `semantic_navigate` execution modes (`deep` default, `fast` lightweight) for latency/token control.
- [x] Added `semantic_navigate` strategy control (`balanced|definition_first|references_first`) with step-order metadata.
- [x] Added `diagnostics_delta` per-file aggregation (`file_summary`, `top_hotspots`) for large diagnostics payload triage.
- [x] Added `doctor.benchmarkInsights` to consume latest benchmark JSON and emit actionable budget recommendations.
- [x] Added benchmark baseline trend analysis in `doctor.benchmarkInsights.trend` with regression/improvement deltas.
- [x] Added unified `type_hierarchy` approximate fallback (`fallback_used=true`) when backend method is unavailable.
- [x] Added unified `inlay_hint_resolve` fallback via `inlay_hints` when backend resolver is unavailable.
- [x] Added `doctor.llmSemanticDefaults` auto-parameter recommendations for `semantic_navigate` and `diagnostics_delta`.
- [x] Added `doctor.capability_snapshot_id` reuse path to avoid repeated capability probing.
- [x] Added `diagnostics_delta` incremental diagnostics tool to reduce repeated large diagnostics payload reads.
- [x] Added semantic `confidence` / `confidence_reason` hints for fallback and strict error cases.
- [x] Structured strict `recovery_plan[]` with executable `type/tool/args` fields for direct LLM tool-calling.
- [x] Added doctor bundled Python runtime probe (`workspaceDependencyChecks.python_bundled_runtime`) for handshake failure triage.

### P2
- [x] Added `scripts/benchmark-report.ts` to emit machine-readable benchmark JSON with per-case latency/cost fields.
- [x] Added baseline trend comparison (`--baseline`) and regression gate (`--fail-on-regression`) in benchmark report script.

## Suggested Next Commands

```bash
# Full benchmark matrix
bun run test:benchmark

# Machine-readable benchmark report + trend diff
bun run benchmark:report
bun run scripts/benchmark-report.ts --out .tmp/benchmark-latest.json --baseline .tmp/benchmark-baseline.json

# Mixed-root-only quick verification
bun test test/integration/mixed-root-benchmark-matrix.test.ts

# Doctor and strict semantic diagnostics
bun test test/integration/meta.test.ts test/integration/vue-strict-semantic.test.ts
```

## Techbet LSP Feature Backlog (LLM-first)

### P0 - Implement next

- [x] `semantic_session_start` bootstrap tool (language/workspace/dependency checks + next steps).
- [x] Unified semantic error contract normalization (`error_code`, `next_step`, `install_commands`, `missing_packages`, `resolved_language`, `resolved_workspace`).
- [x] `implementation` (TypeScript done; Python/Vue pending by backend capability).
- [x] `type_definition` (TypeScript done; Vue/Python pending by backend capability).
- [x] `prepare_rename` guard before `rename` (TypeScript done; Python/Vue pending by backend capability).

### P1 - High-value after P0

- [x] `call_hierarchy` (TypeScript implemented end-to-end; Python/Vue pending by backend capability).
- [x] `type_hierarchy` unified wrapper (strict backend call when available, approximate fallback otherwise).
- [x] `code_lens` unified wrapper with compact summaries (TypeScript implemented; Python/Vue pending).
- [x] `document_highlight` for fast local symbol understanding (TypeScript implemented; Python/Vue pending).
- [x] `selection_range` and `folding_range` for chunk-level edits (TypeScript implemented; Python/Vue pending).
- [x] `document_link` extraction for config/router/resource jumps (TypeScript implemented; Python/Vue pending).

### P2 - Advanced capability

- [~] `semantic_tokens` for richer structure-aware reading (TypeScript/Python/Vue wrappers implemented; strict `NOT_IMPLEMENTED` where backend capability is absent).
- [~] `linked_editing_range` for paired structural edits (TypeScript/Python/Vue wrappers implemented; strict `NOT_IMPLEMENTED` where backend capability is absent).
- [x] `moniker` for cross-package symbol identity (TypeScript/Python/Vue implemented).
- [x] `inlay_hint/resolve` optimization path for large files (windowed hint spans + unified fallback resolve path across languages).

### Notes

- Scope policy: implement only where backend can support reliably; return strict structured `NOT_IMPLEMENTED` with `next_step` otherwise.
- Validation policy: every new tool gets at least one benchmark-backed integration test before moving to next backlog item.
