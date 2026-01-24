// Benchmark test for Pyright MCP Server
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const fixturesDir = resolve(__dirname, '../../fixtures');

/**
 * Run a benchmark for a given function
 * @param {string} name - Name of the benchmark
 * @param {Function} fn - Async function to benchmark
 * @param {number} iterations - Number of iterations
 * @param {number} warmup - Number of warmup iterations
 * @returns {Object} Benchmark result
 */
async function runBenchmark(name, fn, iterations = 10, warmup = 2) {
  // Warmup runs
  for (let i = 0; i < warmup; i++) {
    try {
      await fn();
    } catch (e) {
      // Ignore warmup errors
    }
  }

  // Timed runs
  const times = [];
  let successes = 0;

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    try {
      const result = await fn();
      const elapsed = performance.now() - start;
      times.push(elapsed);

      // Check if result has error
      if (result?.content?.[0]?.text) {
        const text = result.content[0].text;
        if (!text.includes('Error') && !text.includes('error')) {
          successes++;
        }
      }
    } catch (e) {
      times.push(performance.now() - start);
    }
  }

  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const variance = times.reduce((sum, t) => sum + Math.pow(t - mean, 2), 0) / times.length;
  const std = Math.sqrt(variance);

  return {
    tool: name,
    iterations,
    mean_ms: mean,
    std_ms: std,
    min_ms: Math.min(...times),
    max_ms: Math.max(...times),
    success_rate: successes / iterations,
  };
}

async function main() {
  console.log('=== Pyright MCP Server Benchmark ===\n');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [resolve(projectRoot, 'dist/index.js'), fixturesDir],
  });

  const client = new Client({
    name: 'benchmark-client',
    version: '1.0.0',
  });

  await client.connect(transport);
  console.log('Connected to MCP server\n');

  const testFile = resolve(fixturesDir, 'test.py');
  const utilsFile = resolve(fixturesDir, 'mypackage/utils.py');

  const results = [];

  // Benchmark hover
  console.log('Running hover benchmark...');
  results.push(await runBenchmark('hover', async () => {
    return client.callTool({
      name: 'hover',
      arguments: { file: testFile, line: 19, column: 7 },
    });
  }, 20));

  // Benchmark definition
  console.log('Running definition benchmark...');
  results.push(await runBenchmark('definition', async () => {
    return client.callTool({
      name: 'definition',
      arguments: { file: testFile, line: 27, column: 14 },
    });
  }, 20));

  // Benchmark references
  console.log('Running references benchmark...');
  results.push(await runBenchmark('references', async () => {
    return client.callTool({
      name: 'references',
      arguments: { file: testFile, line: 23, column: 14 },
    });
  }, 20));

  // Benchmark completions
  console.log('Running completions benchmark...');
  results.push(await runBenchmark('completions', async () => {
    return client.callTool({
      name: 'completions',
      arguments: { file: testFile, line: 27, column: 9 },
    });
  }, 20));

  // Benchmark symbols
  console.log('Running symbols benchmark...');
  results.push(await runBenchmark('symbols', async () => {
    return client.callTool({
      name: 'symbols',
      arguments: { file: testFile },
    });
  }, 20));

  // Benchmark diagnostics
  console.log('Running diagnostics benchmark...');
  results.push(await runBenchmark('diagnostics', async () => {
    return client.callTool({
      name: 'diagnostics',
      arguments: { path: testFile },
    });
  }, 20));

  // Benchmark signature_help
  console.log('Running signature_help benchmark...');
  results.push(await runBenchmark('signature_help', async () => {
    return client.callTool({
      name: 'signature_help',
      arguments: { file: testFile, line: 54, column: 17 },
    });
  }, 20));

  // Print summary table
  console.log('\n' + '='.repeat(80));
  console.log('PYRIGHT MCP SERVER BENCHMARK SUMMARY');
  console.log('='.repeat(80));
  console.log(
    'Tool'.padEnd(18) +
    'Mean (ms)'.padEnd(14) +
    'Std (ms)'.padEnd(14) +
    'Min (ms)'.padEnd(14) +
    'Max (ms)'.padEnd(14)
  );
  console.log('-'.repeat(80));

  for (const r of results) {
    console.log(
      r.tool.padEnd(18) +
      r.mean_ms.toFixed(2).padEnd(14) +
      r.std_ms.toFixed(2).padEnd(14) +
      r.min_ms.toFixed(2).padEnd(14) +
      r.max_ms.toFixed(2).padEnd(14)
    );
  }
  console.log('='.repeat(80));

  // Output JSON for comparison
  const output = {
    implementation: 'pyright-mcp',
    language: 'TypeScript',
    results: results.map(r => ({
      tool: r.tool,
      mean_ms: Number(r.mean_ms.toFixed(2)),
      std_ms: Number(r.std_ms.toFixed(2)),
      min_ms: Number(r.min_ms.toFixed(2)),
      max_ms: Number(r.max_ms.toFixed(2)),
      success_rate: r.success_rate,
    })),
  };

  console.log('\nJSON Output:');
  console.log(JSON.stringify(output, null, 2));

  await client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
