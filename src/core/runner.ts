import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyMutant, type Mutant } from './mutate.js';

export interface RunResult {
  passed: boolean;
  timedOut: boolean;
  exitCode: number | null;
  durationMs: number;
  /** Last ~4 KB of combined output, useful for debugging */
  tail: string;
}

export type MutantStatus = 'caught' | 'survived' | 'timeout' | 'error';

export interface EvaluatedMutant extends Mutant {
  status: MutantStatus;
  durationMs: number;
}

/** Run a shell command (the project's test command) with a hard timeout. */
export function runCommand(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let tail = '';
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-4096);
    };
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Kill the whole process group (test runners spawn workers)
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ passed: !timedOut && code === 0, timedOut, exitCode: code, durationMs: Date.now() - started, tail });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ passed: false, timedOut: false, exitCode: null, durationMs: Date.now() - started, tail: String(err) });
    });
  });
}

export interface EvaluateOptions {
  cwd: string;
  testCommand: string;
  /** Timeout for each test run. Defaults to 3x the baseline duration, min 30s. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export interface EvaluateReport {
  baseline: RunResult;
  mutants: EvaluatedMutant[];
}

/**
 * 1. Run the tests on the untouched code (they must pass).
 * 2. For each mutant: write the mutated file, run the tests, restore the file.
 * The original file content is ALWAYS restored, even on errors.
 */
export async function evaluateMutants(mutants: Mutant[], opts: EvaluateOptions): Promise<EvaluateReport> {
  const log = opts.log ?? (() => {});
  const generousTimeout = opts.timeoutMs ?? 10 * 60_000;
  log(`Running baseline tests: ${opts.testCommand}`);
  const baseline = await runCommand(opts.testCommand, opts.cwd, generousTimeout);
  if (!baseline.passed) {
    return { baseline, mutants: [] };
  }
  const perRunTimeout = opts.timeoutMs ?? Math.max(30_000, baseline.durationMs * 3 + 5_000);

  const results: EvaluatedMutant[] = [];
  const originals = new Map<string, string>();
  const restoreAll = () => {
    for (const [path, content] of originals) writeFileSync(path, content);
  };
  const onSignal = () => {
    restoreAll();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    for (const m of mutants) {
      const path = join(opts.cwd, m.file);
      if (!originals.has(path)) originals.set(path, readFileSync(path, 'utf8'));
      const original = originals.get(path)!;
      let status: MutantStatus = 'error';
      let durationMs = 0;
      try {
        writeFileSync(path, applyMutant(original, m));
        const r = await runCommand(opts.testCommand, opts.cwd, perRunTimeout);
        durationMs = r.durationMs;
        status = r.timedOut ? 'timeout' : r.passed ? 'survived' : 'caught';
      } finally {
        writeFileSync(path, original);
      }
      log(`  ${m.file}:${m.line}  ${m.original || '!'} -> ${m.replacement || '(removed)'}  => ${status} (${durationMs} ms)`);
      results.push({ ...m, status, durationMs });
    }
  } finally {
    restoreAll();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  return { baseline, mutants: results };
}
