#!/usr/bin/env node
// ── Factorial Stress Test Harness ──────────────────────────────────────────
// Offline Node.js script that loads scenario JSON files, runs each framing
// through deterministic guards, and produces JSON + terminal reports.
//
// Usage:
//   node tests/stress/harness.mjs tests/stress/scenarios/inbox-injection.json
//   node tests/stress/harness.mjs tests/stress/scenarios/

import fs from "node:fs/promises";
import path from "node:path";
import {
  detectInjectionPatterns,
  detectMemoryInjection,
  guardMemoryWriteCore,
} from "../../src/security-core.js";
import {
  computeRoutingScore,
  scorePromptComplexity,
  sessionTrajectory,
} from "../../src/tier-routing.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toBase64(text) {
  return Buffer.from(text, "utf-8").toString("base64");
}

// ── Consistency Score ─────────────────────────────────────────────────────

function calculateConsistency(results) {
  if (results.length <= 1) return { score: 1.0, uniqueOutcomes: 1, divergentFramings: [] };
  const outcomes = results.map(r => JSON.stringify(r.checks));
  const uniqueOutcomes = new Set(outcomes);
  return {
    score: uniqueOutcomes.size === 1
      ? 1.0
      : 1 - (uniqueOutcomes.size - 1) / Math.max(1, results.length - 1),
    uniqueOutcomes: uniqueOutcomes.size,
    divergentFramings: results
      .filter((r, i) => outcomes[i] !== outcomes[0])
      .map(r => r.framing)
  };
}

// ── Guard Runner ──────────────────────────────────────────────────────────

function runGuards(rendered, scenario) {
  const injectionScan = detectInjectionPatterns(rendered);
  const memoryScan = detectMemoryInjection(rendered);
  const complexity = scorePromptComplexity(rendered);

  // Reset trajectory state between framings to avoid cross-contamination
  sessionTrajectory.reset();
  const routing = computeRoutingScore(rendered);

  const guardResults = {
    injectionFlagged: injectionScan.flagged,
    injectionPatterns: injectionScan.patterns,
    memoryInjectionFlagged: memoryScan.flagged,
    memoryPatterns: memoryScan.allPatterns || [],
    routingTier: routing.tier,
    routingScore: routing.score,
    routingSignals: routing.signals || [],
    complexityScore: complexity.score,
    complexitySignals: complexity.signals || [],
  };

  // Memory guard (if scenario targets it)
  if (scenario.expectedBehaviour?.["memory-guard"]) {
    const memGuard = guardMemoryWriteCore(rendered, "Chief of Staff/Memory", "append", {});
    guardResults.memoryGuardBlocked = !memGuard.allowed;
    guardResults.memoryGuardReason = memGuard.reason || "";
  }

  return guardResults;
}

// ── Expectation Checker ───────────────────────────────────────────────────

function evaluateExpectations(guardResults, expectedBehaviour) {
  const checks = {};

  if (expectedBehaviour["injection-detection"] === "flagged") {
    checks.injectionDetection = guardResults.injectionFlagged || guardResults.memoryInjectionFlagged;
  }

  if (expectedBehaviour["tier-routing"] === "power-or-above") {
    checks.tierRouting = guardResults.routingTier !== "mini";
  }

  if (expectedBehaviour["memory-guard"] === "blocked") {
    checks.memoryGuard = guardResults.memoryGuardBlocked === true;
  }

  return checks;
}

// ── Scenario Runner ───────────────────────────────────────────────────────

async function runScenario(scenarioPath) {
  const raw = await fs.readFile(scenarioPath, "utf-8");
  const scenario = JSON.parse(raw);
  const results = [];

  const baseIntents = Array.isArray(scenario.baseIntent)
    ? scenario.baseIntent
    : [scenario.baseIntent];

  for (const intent of baseIntents) {
    for (const framing of scenario.framings) {
      const rendered = framing.template
        .replace(/\{intent\}/g, intent)
        .replace(/\{base64_intent\}/g, toBase64(intent));

      const guardResults = runGuards(rendered, scenario);
      const checks = evaluateExpectations(guardResults, scenario.expectedBehaviour);
      const allPassed = Object.values(checks).every(Boolean);

      results.push({
        intent: intent.slice(0, 80),
        framing: framing.label,
        rendered: rendered.slice(0, 200),
        ...guardResults,
        checks,
        passed: allPassed,
      });
    }
  }

  const consistency = calculateConsistency(results);

  return {
    scenario: scenario.name,
    description: scenario.description || "",
    timestamp: new Date().toISOString(),
    totalCases: results.length,
    totalPassed: results.filter(r => r.passed).length,
    totalFailed: results.filter(r => !r.passed).length,
    failedCases: results.filter(r => !r.passed).map(r => ({
      intent: r.intent,
      framing: r.framing,
      checks: r.checks,
      routingTier: r.routingTier,
      routingScore: r.routingScore,
      injectionFlagged: r.injectionFlagged,
      memoryInjectionFlagged: r.memoryInjectionFlagged,
    })),
    consistency,
    details: results,
  };
}

// ── Terminal Output ───────────────────────────────────────────────────────

function printSummary(report) {
  const allPassed = report.totalFailed === 0;
  const icon = allPassed ? "✅" : "❌";
  const consistencyPct = (report.consistency.score * 100).toFixed(0);

  console.log(`\n${icon} ${report.scenario} — ${report.totalPassed}/${report.totalCases} passed, consistency ${consistencyPct}%`);

  if (report.totalFailed > 0) {
    console.log(`  Failed cases:`);
    for (const f of report.failedCases) {
      const failedChecks = Object.entries(f.checks)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(", ");
      console.log(`    - [${f.framing}] "${f.intent}" — failed: ${failedChecks}`);
      if (f.routingTier) {
        console.log(`      routing: ${f.routingTier} (score ${f.routingScore.toFixed(3)})`);
      }
    }
  }

  if (report.consistency.divergentFramings.length > 0) {
    console.log(`  Divergent framings: ${report.consistency.divergentFramings.join(", ")}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const scenarioArg = process.argv[2];
  if (!scenarioArg) {
    console.error("Usage: node tests/stress/harness.mjs <scenario.json | scenarios/>");
    process.exit(1);
  }

  let scenarioFiles;
  try {
    const stat = await fs.stat(scenarioArg);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(scenarioArg);
      scenarioFiles = entries
        .filter(f => f.endsWith(".json"))
        .map(f => path.join(scenarioArg, f))
        .sort();
    } else {
      scenarioFiles = [scenarioArg];
    }
  } catch (err) {
    console.error(`Error reading ${scenarioArg}:`, err.message);
    process.exit(1);
  }

  if (scenarioFiles.length === 0) {
    console.error("No scenario files found.");
    process.exit(1);
  }

  console.log(`\nStress Test Harness — ${scenarioFiles.length} scenario(s)`);
  console.log("─".repeat(60));

  const allReports = [];
  let totalPassed = 0;
  let totalFailed = 0;

  for (const file of scenarioFiles) {
    try {
      const report = await runScenario(file);
      allReports.push(report);
      totalPassed += report.totalPassed;
      totalFailed += report.totalFailed;

      // Write JSON report
      const reportDir = path.join(path.dirname(file), "..", "reports");
      await fs.mkdir(reportDir, { recursive: true });
      const reportName = `${todayKey()}-${report.scenario}.json`;
      await fs.writeFile(
        path.join(reportDir, reportName),
        JSON.stringify(report, null, 2)
      );

      printSummary(report);
    } catch (err) {
      console.error(`\n❌ Error running ${path.basename(file)}:`, err.message);
      totalFailed += 1;
    }
  }

  // Final summary
  console.log("\n" + "─".repeat(60));
  const allGreen = totalFailed === 0;
  console.log(`${allGreen ? "✅" : "❌"} Total: ${totalPassed} passed, ${totalFailed} failed across ${allReports.length} scenario(s)`);

  if (!allGreen) process.exit(1);
}

main().catch(err => {
  console.error("Harness error:", err);
  process.exit(1);
});
