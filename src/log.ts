/**
 * Small logging helpers so every run looks the same in the GitHub Actions log.
 *
 * Nothing here ever prints a secret: callers only pass variable names or
 * normal text, never key values.
 */
import { appendFileSync } from "node:fs";

/** Prints a normal step message. */
export function logStep(message: string): void {
  console.log(`\n[blogger-auto-poster] ${message}`);
}

/** Prints a smaller detail line. */
export function logInfo(message: string): void {
  console.log(`  - ${message}`);
}

/** Prints a warning (something looks odd but the run continues). */
export function logWarn(message: string): void {
  console.warn(`  ! WARNING: ${message}`);
}

/** Prints an error line. */
export function logError(message: string): void {
  console.error(`  x ERROR: ${message}`);
}

/** Waits for the given number of milliseconds. Used for retry backoff. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Appends a line to the GitHub Actions job summary when we run inside
 * GitHub Actions. Does nothing in local runs.
 */
export function addToJobSummary(line: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, `${line}\n`, "utf8");
  } catch {
    // A missing summary file must never break the run.
  }
}
