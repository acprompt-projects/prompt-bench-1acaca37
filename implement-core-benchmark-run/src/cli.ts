===
#!/usr/bin/env node
import { loadConfig, runBenchmark } from "./runner.js";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help")) {
    console.log(`prompt-bench – LLM prompt benchmark runner

Usage:
  prompt-bench <config.json> [--output <path>] [--quiet]

Options:
  --output <path>  Write JSON report to file (default: ./benchmark-report.json)
  --quiet          Suppress console output of results
  --help           Show this help
`);
    process.exit(0);
  }

  const configPath = args[0];
  const outputIdx = args.indexOf("--output");
  const outputPath = outputIdx !== -1 && args[outputIdx + 1] ? args[outputIdx + 1] : "benchmark-report.json";
  const quiet = args.includes("--quiet");

  if (!quiet) console.log(`Loading config from ${configPath}...`);

  const config = await loadConfig(configPath);

  if (!quiet) {
    console.log(`Benchmark: ${config.name}`);
    console.log(`  Prompts:   ${config.prompts.length}`);
    console.log(`  Endpoints: ${config.endpoints.length}`);
    console.log(`  Rubrics:   ${config.rubrics.length}`);
    console.log(`  Iterations: ${config.iterations ?? 1}`);
    console.log("Running...");
  }

  const report = await runBenchmark(config);

  if (!quiet) {
    console.log("\n── Results ──────────────────────────────────────────");
    for (const row of report.summary) {
      const errTag = row.errors > 0 ? ` (${row.errors} errors)` : "";
      console.log(
        `  [${row.promptId} → ${row.endpointId}]  score: ${row.avgScore.toFixed(2)}  latency: ${row.avgLatencyMs}ms${errTag}`
      );
    }
    console.log("────────────────────────────────────────────────────");
  }

  const outPath = resolve(outputPath);
  await writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
  if (!quiet) console.log(`\nReport written to ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});