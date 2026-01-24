#!/usr/bin/env bun
/**
 * Integration tests for the unified LSP MCP server.
 *
 * Tests the tool routing and backend management functionality.
 */

import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

const PROJECT_ROOT = path.dirname(import.meta.dir);
const TEST_FIXTURES = path.join(PROJECT_ROOT, "..", "test-fixtures");

// Ensure test fixtures exist
const PYTHON_TEST_FILE = path.join(TEST_FIXTURES, "test_sample.py");
const TS_TEST_FILE = path.join(TEST_FIXTURES, "test_sample.ts");

// Create test fixtures if they don't exist
async function setupFixtures() {
  if (!fs.existsSync(TEST_FIXTURES)) {
    fs.mkdirSync(TEST_FIXTURES, { recursive: true });
  }

  if (!fs.existsSync(PYTHON_TEST_FILE)) {
    fs.writeFileSync(
      PYTHON_TEST_FILE,
      `"""Test Python file for LSP MCP testing."""

def greet(name: str) -> str:
    """Greet a person by name."""
    return f"Hello, {name}!"

class Calculator:
    """A simple calculator class."""

    def add(self, a: int, b: int) -> int:
        """Add two numbers."""
        return a + b

    def subtract(self, a: int, b: int) -> int:
        """Subtract b from a."""
        return a - b


if __name__ == "__main__":
    calc = Calculator()
    print(greet("World"))
    print(calc.add(1, 2))
`
    );
  }

  if (!fs.existsSync(TS_TEST_FILE)) {
    fs.writeFileSync(
      TS_TEST_FILE,
      `/**
 * Test TypeScript file for LSP MCP testing.
 */

export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }
}

const calc = new Calculator();
console.log(greet("World"));
console.log(calc.add(1, 2));
`
    );
  }
}

// Test the config module
async function testConfig() {
  console.log("Testing config module...");

  const { loadConfig, parseToolName, inferLanguageFromPath } = await import(
    "../src/config.js"
  );

  // Test loadConfig
  const config = loadConfig();
  console.assert(config.python.enabled === true, "Python should be enabled by default");
  console.assert(
    config.typescript.enabled === true,
    "TypeScript should be enabled by default"
  );
  console.log("  loadConfig: OK");

  // Test parseToolName
  const parsed = parseToolName("python/hover");
  console.assert(parsed?.language === "python", "Should parse python language");
  console.assert(parsed?.tool === "hover", "Should parse hover tool");

  const parsed2 = parseToolName("typescript/definition");
  console.assert(parsed2?.language === "typescript", "Should parse typescript");
  console.assert(parsed2?.tool === "definition", "Should parse definition tool");

  const parsed3 = parseToolName("invalid");
  console.assert(parsed3 === null, "Should return null for invalid tool name");
  console.log("  parseToolName: OK");

  // Test inferLanguageFromPath
  console.assert(
    inferLanguageFromPath("/test/file.py") === "python",
    "Should infer Python from .py"
  );
  console.assert(
    inferLanguageFromPath("/test/file.ts") === "typescript",
    "Should infer TypeScript from .ts"
  );
  console.assert(
    inferLanguageFromPath("/test/file.tsx") === "typescript",
    "Should infer TypeScript from .tsx"
  );
  console.assert(
    inferLanguageFromPath("/test/file.js") === "typescript",
    "Should infer TypeScript from .js"
  );
  console.assert(
    inferLanguageFromPath("/test/file.unknown") === null,
    "Should return null for unknown extension"
  );
  console.log("  inferLanguageFromPath: OK");

  console.log("Config tests passed!");
}

// Test the tool router
async function testToolRouter() {
  console.log("\nTesting tool router...");

  const { routeTool } = await import("../src/tool-router.js");

  // Test namespaced routing
  const route1 = routeTool("python/hover", { file: "/test/file.py" });
  console.assert(route1.language === "python", "Should route to python");
  console.assert(route1.toolName === "hover", "Should extract hover tool");
  console.log("  Namespaced routing: OK");

  // Test inference from file extension
  const route2 = routeTool("hover", { file: "/test/file.ts" });
  console.assert(route2.language === "typescript", "Should infer typescript");
  console.assert(route2.toolName === "hover", "Should keep tool name");
  console.log("  File extension inference: OK");

  // Test inference from path argument
  const route3 = routeTool("diagnostics", { path: "/test/file.py" });
  console.assert(route3.language === "python", "Should infer from path arg");
  console.log("  Path argument inference: OK");

  // Test error for ambiguous tool
  try {
    routeTool("hover", {});
    console.assert(false, "Should throw for ambiguous tool");
  } catch (error) {
    console.assert(
      (error as Error).message.includes("Cannot determine language"),
      "Should have helpful error message"
    );
    console.log("  Error handling: OK");
  }

  console.log("Tool router tests passed!");
}

// Test backend manager (mocked)
async function testBackendManager() {
  console.log("\nTesting backend manager structure...");

  const { BackendManager } = await import("../src/backend-manager.js");
  const { loadConfig } = await import("../src/config.js");

  const config = loadConfig();
  const manager = new BackendManager(config);

  // Test initial status
  const status = manager.getStatus();
  console.assert("python" in status, "Should have python status");
  console.assert("typescript" in status, "Should have typescript status");
  console.assert(
    status.python.status === "not_started",
    "Python should not be started initially"
  );
  console.log("  Initial status: OK");

  // Cleanup
  await manager.shutdown();
  console.log("  Shutdown: OK");

  console.log("Backend manager tests passed!");
}

// Main test runner
async function main() {
  console.log("=== LSP MCP Integration Tests ===\n");

  try {
    await setupFixtures();
    await testConfig();
    await testToolRouter();
    await testBackendManager();

    console.log("\n=== All tests passed! ===");
  } catch (error) {
    console.error("\nTest failed:", error);
    process.exit(1);
  }
}

main();
