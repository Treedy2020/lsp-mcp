import * as fs from "fs";
import * as path from "path";
import { McpTestClient } from "../test/utils/mcp-client.js";

type CaseSpec = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
};

type CaseResult = {
  id: string;
  tool: string;
  latency_ms: number;
  result_size: number;
  ok: boolean;
  error_code: string | null;
  confidence: number | null;
  truncated: boolean;
  cursor_available: boolean;
};

type BenchmarkReport = {
  schema_version: 1;
  generated_at: string;
  workspace_root: string;
  cases: CaseResult[];
  summary: {
    total_cases: number;
    ok_cases: number;
    error_cases: number;
    total_latency_ms: number;
  };
};

function parseArgs(argv: string[]): { out: string; baseline: string | null; failOnRegression: boolean } {
  let out = path.resolve(process.cwd(), ".tmp/benchmark-latest.json");
  let baseline: string | null = null;
  let failOnRegression = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" && argv[i + 1]) {
      out = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--baseline" && argv[i + 1]) {
      baseline = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--fail-on-regression") {
      failOnRegression = true;
    }
  }
  return { out, baseline, failOnRegression };
}

function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

async function runCase(client: McpTestClient, spec: CaseSpec): Promise<CaseResult> {
  const startedAt = Date.now();
  const payload = await client.callTool(spec.tool, spec.args);
  const latencyMs = Date.now() - startedAt;
  const errorCode = typeof payload?.error_code === "string" ? payload.error_code : null;
  return {
    id: spec.id,
    tool: spec.tool,
    latency_ms: latencyMs,
    result_size: typeof payload?.result_size === "number" ? payload.result_size : jsonSize(payload),
    ok: !errorCode,
    error_code: errorCode,
    confidence: typeof payload?.confidence === "number" ? payload.confidence : null,
    truncated: payload?.truncated === true,
    cursor_available: payload?.cursor_available === true,
  };
}

function printTrend(report: BenchmarkReport, baselinePath: string): number {
  if (!fs.existsSync(baselinePath)) {
    console.log(`[benchmark-report] baseline not found: ${baselinePath}`);
    return 0;
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as BenchmarkReport;
  const baselineMap = new Map(baseline.cases.map((c) => [c.id, c]));
  let regressions = 0;
  console.log("[benchmark-report] trend vs baseline:");
  for (const current of report.cases) {
    const prev = baselineMap.get(current.id);
    if (!prev || prev.latency_ms <= 0) {
      console.log(`  - ${current.id}: no baseline`);
      continue;
    }
    const deltaMs = current.latency_ms - prev.latency_ms;
    const deltaPct = (deltaMs / prev.latency_ms) * 100;
    const direction = deltaMs > 0 ? "slower" : "faster";
    const roundedPct = Math.round(deltaPct * 10) / 10;
    console.log(`  - ${current.id}: ${deltaMs}ms (${roundedPct}%) ${direction}`);
    if (deltaPct > 20) regressions += 1;
  }
  return regressions;
}

async function main() {
  const { out, baseline, failOnRegression } = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const benchmarksRoot = path.resolve(root, "../benchmarks");
  const zodRoot = path.join(benchmarksRoot, "zod");
  const fastapiRoot = path.join(benchmarksRoot, "fastapi");
  const vitesseRoot = path.join(benchmarksRoot, "vitesse");
  const serverPath = path.resolve(root, "src/index.ts");

  const requiredDirs = [benchmarksRoot, zodRoot, fastapiRoot, vitesseRoot];
  for (const dir of requiredDirs) {
    if (!fs.existsSync(dir)) {
      throw new Error(`Required benchmark workspace not found: ${dir}`);
    }
  }

  const client = new McpTestClient(serverPath, {
    env: {
      ...process.env,
      LSP_MCP_REQUIRE_BUNDLED_BACKENDS: "true",
      LSP_MCP_SINGLETON_BACKEND: "false",
    },
  });

  try {
    await client.callTool("switch_workspace", { path: benchmarksRoot });
    await client.callTool("discover_language_workspaces", { root: benchmarksRoot, max_depth: 2, apply: true });

    const cases: CaseSpec[] = [
      {
        id: "ts_hover",
        tool: "hover",
        args: { file: "packages/zod/src/v4/core/util.ts", line: 218, column: 25 },
      },
      {
        id: "py_hover",
        tool: "hover",
        args: { file: "fastapi/applications.py", line: 1336, column: 9 },
      },
      {
        id: "vue_definition",
        tool: "definition",
        args: { file: path.join(vitesseRoot, "src/components/TheFooter.vue"), line: 21, column: 63 },
      },
      {
        id: "semantic_navigate_balanced_deep",
        tool: "semantic_navigate",
        args: {
          file: "packages/zod/src/v4/core/util.ts",
          line: 218,
          column: 25,
          query: "jsonStringifyReplacer",
          mode: "deep",
          strategy: "balanced",
        },
      },
      {
        id: "semantic_navigate_definition_first_fast",
        tool: "semantic_navigate",
        args: {
          file: "packages/zod/src/v4/core/util.ts",
          line: 218,
          column: 25,
          mode: "fast",
          strategy: "definition_first",
        },
      },
      {
        id: "semantic_navigate_references_first_fast",
        tool: "semantic_navigate",
        args: {
          file: "packages/zod/src/v4/core/util.ts",
          line: 218,
          column: 25,
          mode: "fast",
          strategy: "references_first",
        },
      },
      {
        id: "diagnostics_delta_first",
        tool: "diagnostics_delta",
        args: { path: "packages/zod/src/v4/core/util.ts", preview_limit: 20, page_size: 20 },
      },
      {
        id: "diagnostics_delta_second",
        tool: "diagnostics_delta",
        args: { path: "packages/zod/src/v4/core/util.ts", preview_limit: 20, page_size: 20 },
      },
    ];

    const caseResults: CaseResult[] = [];
    for (const spec of cases) {
      caseResults.push(await runCase(client, spec));
    }

    const report: BenchmarkReport = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      workspace_root: benchmarksRoot,
      cases: caseResults,
      summary: {
        total_cases: caseResults.length,
        ok_cases: caseResults.filter((c) => c.ok).length,
        error_cases: caseResults.filter((c) => !c.ok).length,
        total_latency_ms: caseResults.reduce((sum, c) => sum + c.latency_ms, 0),
      },
    };

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
    console.log(`[benchmark-report] wrote ${out}`);

    let regressions = 0;
    if (baseline) {
      regressions = printTrend(report, baseline);
    }
    if (failOnRegression && regressions > 0) {
      process.exitCode = 2;
    }
  } finally {
    client.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
