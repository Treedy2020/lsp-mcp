import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const ROOT = path.join(os.tmpdir(), `lsp-mcp-discover-${Date.now()}`);
const PY_DIR = path.join(ROOT, "fastapi");
const TS_DIR = path.join(ROOT, "zod");
const VUE_DIR = path.join(ROOT, "vitesse");

describe("Discover Language Workspaces", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    fs.mkdirSync(PY_DIR, { recursive: true });
    fs.mkdirSync(TS_DIR, { recursive: true });
    fs.mkdirSync(VUE_DIR, { recursive: true });

    fs.writeFileSync(path.join(PY_DIR, "pyproject.toml"), "[project]\nname='fastapi-fixture'\n");
    fs.writeFileSync(path.join(TS_DIR, "package.json"), JSON.stringify({ name: "zod-fixture", devDependencies: { typescript: "^5.9.0" } }));
    fs.writeFileSync(path.join(TS_DIR, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022" } }));
    fs.writeFileSync(
      path.join(VUE_DIR, "package.json"),
      JSON.stringify({ name: "vitesse-fixture", dependencies: { vue: "^3.0.0" }, devDependencies: { typescript: "^5.9.0" } })
    );
    fs.writeFileSync(path.join(VUE_DIR, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022" } }));
    fs.writeFileSync(path.join(VUE_DIR, "vite.config.ts"), "export default {};\n");

    client = new McpTestClient(SERVER_PATH);
  });

  afterAll(() => {
    client.kill();
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it("should discover and apply language workspace mappings", async () => {
    const result = await client.callTool("discover_language_workspaces", {
      root: ROOT,
      apply: true,
      max_depth: 2,
    });

    expect(result.suggestions.python).toBe(PY_DIR);
    expect(result.suggestions.typescript).toBe(TS_DIR);
    expect(result.suggestions.vue).toBe(VUE_DIR);

    const status = await client.callTool("status", {});
    expect(status.workspaces.overrides.python).toBe(PY_DIR);
    expect(status.workspaces.overrides.typescript).toBe(TS_DIR);
    expect(status.workspaces.overrides.vue).toBe(VUE_DIR);
  });
});
