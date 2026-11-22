import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MapEntry } from './map.js';
import { findMutants, hashSeed, selectMutants, type Mutant } from './mutate.js';
import { buildQuiz, type Lang, type Quiz, type QuizKind } from './quiz.js';
import { evaluateMutants, type EvaluatedMutant, type RunResult } from './runner.js';
import type { KeyMode } from './seal.js';

export interface GenerateOptions {
  cwd: string;
  testCommand: string;
  lang: Lang;
  key: Buffer;
  keyMode: KeyMode;
  kind: QuizKind;
  maxMutants: number;
  optionsCount: number;
  timeoutMs?: number;
  /** Restrict mutations to these lines (e.g. lines changed in a PR) */
  lines?: Map<string, Set<number>>;
  /** Or mutate these whole files */
  files?: string[];
  sha?: string;
  seed?: string;
  log?: (msg: string) => void;
}

export type GenerateStatus = 'ok' | 'no-mutants' | 'baseline-failed' | 'too-few';

export interface GenerateResult {
  status: GenerateStatus;
  quiz: Quiz | null;
  candidates: number;
  baseline?: RunResult;
  evaluated: EvaluatedMutant[];
}

export async function generateQuiz(opts: GenerateOptions): Promise<GenerateResult> {
  const log = opts.log ?? (() => {});
  const all: Mutant[] = [];
  const targets: Array<[string, Set<number> | undefined]> = opts.lines
    ? [...opts.lines.entries()]
    : (opts.files ?? []).map((f) => [f, undefined] as [string, undefined]);
  for (const [file, lines] of targets) {
    const path = join(opts.cwd, file);
    if (!existsSync(path)) continue;
    const src = readFileSync(path, 'utf8');
    if (src.length > 1_000_000) continue; // generated bundles are not worth quizzing
    all.push(...findMutants(file, src, { lines }));
  }
  log(`Found ${all.length} possible changes in ${targets.length} file(s)`);
  if (all.length === 0) return { status: 'no-mutants', quiz: null, candidates: 0, evaluated: [] };

  const seed = hashSeed(opts.seed ?? opts.sha ?? String(Date.now()));
  const chosen = selectMutants(all, opts.maxMutants, seed);
  log(`Testing ${chosen.length} of them with: ${opts.testCommand}`);
  const report = await evaluateMutants(chosen, { cwd: opts.cwd, testCommand: opts.testCommand, timeoutMs: opts.timeoutMs, log });
  if (!report.baseline.passed) {
    log('Baseline tests failed:\n' + report.baseline.tail);
    return { status: 'baseline-failed', quiz: null, candidates: all.length, baseline: report.baseline, evaluated: [] };
  }
  const quiz = buildQuiz(report.mutants, {
    count: opts.optionsCount,
    kind: opts.kind,
    lang: opts.lang,
    key: opts.key,
    keyMode: opts.keyMode,
    testCommand: opts.testCommand,
    sha: opts.sha,
    seed,
  });
  return { status: quiz ? 'ok' : 'too-few', quiz, candidates: all.length, baseline: report.baseline, evaluated: report.mutants };
}

/** Test files that mention a source file's module name (a cheap "where is this tested?" hint). */
export function relatedTests(cwd: string, file: string, tracked: string[], isTest: (p: string) => boolean): string[] {
  const stem = basename(file).replace(/\.[^.]+$/, '');
  if (stem.length < 3 || stem === 'index') return [];
  const re = new RegExp(`['"\`/]${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.[cm]?[jt]sx?)?['"\`]`);
  const out: string[] = [];
  for (const t of tracked) {
    if (!isTest(t)) continue;
    try {
      if (re.test(readFileSync(join(cwd, t), 'utf8'))) out.push(t);
    } catch {
      /* unreadable */
    }
    if (out.length >= 3) break;
  }
  return out;
}

export const TEST_FILE_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|tests?)\//;

/** Files of the map that are mentioned in free text (issue bodies, stack traces...). */
export function findMentionedFiles(text: string, entries: MapEntry[]): MapEntry[] {
  const found: MapEntry[] = [];
  const lower = text.toLowerCase();
  for (const e of entries) {
    const f = e.file.toLowerCase();
    const base = basename(f);
    const stem = base.replace(/\.[^.]+$/, '');
    if (lower.includes(f)) {
      found.push(e);
      continue;
    }
    // Bare file name like `cart.ts` or `cart.ts:42`, but only if it is distinctive
    if (stem.length >= 4 && stem !== 'index' && new RegExp(`(^|[\\s/\`'"(])${escapeRe(base)}(?=$|[\\s:\`'")),.])`).test(lower)) found.push(e);
  }
  return found;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
