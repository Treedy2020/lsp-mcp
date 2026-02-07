# Techbet Benchmark Report Template

Use this template after each benchmark run to keep results comparable across iterations.

## Run Metadata

- Date:
- Commit:
- Branch:
- Runner:
- Command:
  - `bun run test:benchmark`
- Environment:
  - `LSP_MCP_REQUIRE_BUNDLED_BACKENDS=true`
  - `LSP_MCP_SINGLETON_BACKEND=false` (benchmark mode)

## Overall Summary

- Total tests:
- Passed:
- Failed:
- Total duration:
- Regressions vs previous run:

## Language Matrix

| Language | Benchmark | Pass Rate | Avg Latency (ms) | Retries | Key Failure Signature |
|---|---|---:|---:|---:|---|
| TypeScript | zod |  |  |  |  |
| Python | fastapi |  |  |  |  |
| Vue | vitesse |  |  |  |  |

## Mixed-Root Scenario

- Root used:
- Discovery call:
  - `discover_language_workspaces(root=..., apply=true)`
- Suggested mappings:
  - python:
  - typescript:
  - vue:
- Semantic verification:
  - TypeScript: `hover` status / latency:
  - Python: `hover` status / latency:
  - Vue: `definition` status / latency:
- Routing metadata checks:
  - `resolved_language` correctness:
  - `resolved_workspace` correctness:

## Failure Signature Breakdown

| Signature | Count | Severity | First Seen | Affected Area | Suggested Fix |
|---|---:|---|---|---|---|
| `LANGUAGE_WORKSPACE_REQUIRED` |  |  |  | routing |  |
| `VUE_SEMANTIC_DEPS_MISSING` |  |  |  | deps |  |
| `BACKEND_SINGLETON_LOCK_FAILED` |  |  |  | concurrency |  |
| `Invalid or expired cursor` |  |  |  | paging |  |
| Other |  |  |  |  |  |

## Doctor Output Review

- `languageCommandChains` complete: yes/no
- Missing package guidance quality:
  - python:
  - typescript:
  - vue:
- Next-step commands executable as-is: yes/no

## Findings and Actions

### P0
- [ ] Item:
- [ ] Item:

### P1
- [ ] Item:
- [ ] Item:

### P2
- [ ] Item:
- [ ] Item:

## Suggested Next Commands

```bash
# Re-run benchmark matrix
bun run test:benchmark

# Focused mixed-root regression check
bun test test/integration/mixed-root-benchmark-matrix.test.ts

# Validate doctor + strict dependency messaging
bun test test/integration/meta.test.ts test/integration/vue-strict-semantic.test.ts
```

