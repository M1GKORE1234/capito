import { createHash, randomBytes } from 'node:crypto';
import type { OperatorId } from './mutate.js';
import { hashSeed, mulberry32 } from './mutate.js';
import type { EvaluatedMutant } from './runner.js';
import { seal, unseal, type KeyMode } from './seal.js';

export type Lang = 'en' | 'it';
export type QuizKind = 'pr' | 'digest' | 'on-demand';

export interface QuizOption {
  letter: string;
  file: string;
  line: number;
  operator: OperatorId;
  original: string;
  replacement: string;
  originalLine: string;
  mutatedLine: string;
}

export interface Quiz {
  v: 1;
  id: string;
  kind: QuizKind;
  createdAt: string;
  lang: Lang;
  keyMode: KeyMode;
  /** Encrypted SealedAnswers */
  sealed: string;
  options: QuizOption[];
  testCommand: string;
  /** Commit the mutants were run against */
  sha?: string;
}

export interface SealedAnswers {
  quizId: string;
  /** Letters whose change makes the tests FAIL */
  caught: string[];
  /** Fingerprint of the visible options: a copied quiz with edited files/lines will not open */
  digest: string;
}

export function optionsDigest(options: QuizOption[]): string {
  const canonical = options.map((o) => [o.letter, o.file, o.line, o.operator, o.original, o.replacement]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url').slice(0, 22);
}

/** Max 4 options: keeps the quiz under a minute (and lets Italians write "A e C"). */
export const LETTERS = ['A', 'B', 'C', 'D'];

export interface BuildQuizOptions {
  count: number;
  kind: QuizKind;
  lang: Lang;
  key: Buffer;
  keyMode: KeyMode;
  testCommand: string;
  sha?: string;
  seed?: number;
  now?: Date;
}

/**
 * Turn evaluated mutants into a multiple-answer question:
 * "Which of these changes would make your tests fail?"
 * We try to mix caught and surviving changes so the answer is never obvious.
 */
export function buildQuiz(evaluated: EvaluatedMutant[], opts: BuildQuizOptions): Quiz | null {
  const usable = evaluated.filter((m) => m.status === 'caught' || m.status === 'survived');
  // One option per line at most
  const perLine = new Map<string, EvaluatedMutant>();
  for (const m of usable) {
    const k = `${m.file}:${m.line}`;
    if (!perLine.has(k)) perLine.set(k, m);
  }
  const pool = [...perLine.values()];
  if (pool.length < 2) return null;
  const rng = mulberry32(opts.seed ?? hashSeed(pool.map((m) => m.id).join('|')));
  const shuffle = <T>(arr: T[]): T[] => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  // Prefer changes that teach something (logic, comparisons) over literal tweaks,
  // while keeping the order random inside each tier
  const tier = (m: EvaluatedMutant) => (m.operator === 'num-plus-one' || m.operator === 'bool-flip' ? 2 : m.operator === 'arith' || m.operator === 'update-flip' ? 1 : 0);
  const byTier = (arr: EvaluatedMutant[]) => shuffle(arr).sort((a, b) => tier(a) - tier(b));
  const caught = byTier(pool.filter((m) => m.status === 'caught'));
  const survived = byTier(pool.filter((m) => m.status === 'survived'));
  const count = Math.max(2, Math.min(opts.count, LETTERS.length, pool.length));
  const picked: EvaluatedMutant[] = [];
  // Guarantee a mix when possible
  if (caught.length) picked.push(caught.shift()!);
  if (survived.length && picked.length < count) picked.push(survived.shift()!);
  const rest = byTier([...caught, ...survived]);
  while (picked.length < count && rest.length) picked.push(rest.shift()!);
  const ordered = shuffle(picked);

  const id = randomBytes(5).toString('hex');
  const options: QuizOption[] = ordered.map((m, i) => ({
    letter: LETTERS[i],
    file: m.file,
    line: m.line,
    operator: m.operator,
    original: m.original,
    replacement: m.replacement,
    originalLine: m.originalLine,
    mutatedLine: m.mutatedLine,
  }));
  const answers: SealedAnswers = {
    quizId: id,
    caught: ordered.map((m, i) => (m.status === 'caught' ? LETTERS[i] : null)).filter((x): x is string => x !== null),
    digest: optionsDigest(options),
  };
  return {
    v: 1,
    id,
    kind: opts.kind,
    createdAt: (opts.now ?? new Date()).toISOString(),
    lang: opts.lang,
    keyMode: opts.keyMode,
    sealed: seal(answers, opts.key),
    options,
    testCommand: opts.testCommand,
    sha: opts.sha,
  };
}

export function openAnswers(quiz: Quiz, key: Buffer): SealedAnswers | null {
  const a = unseal<SealedAnswers>(quiz.sealed, key);
  if (!a || a.quizId !== quiz.id || a.digest !== optionsDigest(quiz.options)) return null;
  return a;
}

// ---------------------------------------------------------------------------
// Commands written by humans in comments
// ---------------------------------------------------------------------------

export type Command =
  | { kind: 'answer'; letters: string[] }
  | { kind: 'quiz'; path?: string }
  | { kind: 'map' }
  | { kind: 'help' }
  | { kind: 'invalid'; text: string };

const NONE_WORDS = new Set(['none', 'nessuna', 'nessuno', 'niente', '-', '0', 'nothing']);
const ALL_WORDS = new Set(['all', 'tutte', 'tutti', 'tutto']);

/** Parse the first `/capito ...` line in a comment. Returns null if there is none. */
export function parseCommand(body: string): Command | null {
  const m = /^[ \t]*\/capito\b[ \t]*(.*)$/im.exec(body);
  if (!m) return null;
  const rest = m[1].trim();
  const first = rest.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (first === '' || first === 'help' || first === 'aiuto' || first === '?') return { kind: 'help' };
  if (first === 'quiz' || first === 'domande') {
    const path = rest.split(/\s+/)[1];
    return { kind: 'quiz', path: path ? path.replace(/^`|`$/g, '') : undefined };
  }
  if (first === 'map' || first === 'mappa') return { kind: 'map' };
  if (NONE_WORDS.has(first)) return { kind: 'answer', letters: [] };
  if (ALL_WORDS.has(first)) return { kind: 'answer', letters: ['*'] };
  // Letters: "A C", "a,c", "AC", "A e C", "A and C"
  const cleaned = rest
    .toUpperCase()
    .replace(/\b(AND|E|ET|Y|UND)\b/g, ' ')
    .replace(/[^A-Z]/g, '');
  if (cleaned && [...cleaned].every((c) => LETTERS.includes(c))) {
    return { kind: 'answer', letters: [...new Set(cleaned)].sort() };
  }
  return { kind: 'invalid', text: rest.slice(0, 60) };
}

export interface OptionGrade {
  letter: string;
  file: string;
  line: number;
  operator: OperatorId;
  caught: boolean;
  userSaidCaught: boolean;
  correct: boolean;
}

export interface Grade {
  perOption: OptionGrade[];
  correctCount: number;
  total: number;
  perfect: boolean;
}

export function gradeAnswer(quiz: Quiz, answers: SealedAnswers, letters: string[]): Grade {
  const chosen = letters.includes('*') ? new Set(quiz.options.map((o) => o.letter)) : new Set(letters);
  const caught = new Set(answers.caught);
  const perOption = quiz.options.map((o) => {
    const isCaught = caught.has(o.letter);
    const said = chosen.has(o.letter);
    return { letter: o.letter, file: o.file, line: o.line, operator: o.operator, caught: isCaught, userSaidCaught: said, correct: isCaught === said };
  });
  const correctCount = perOption.filter((p) => p.correct).length;
  return { perOption, correctCount, total: perOption.length, perfect: correctCount === perOption.length };
}

// ---------------------------------------------------------------------------
// Embedding the quiz in a Markdown comment
// ---------------------------------------------------------------------------

const MARKER = 'capito:quiz:v1';

export function encodeQuizMarker(quiz: Quiz): string {
  return `<!-- ${MARKER} ${Buffer.from(JSON.stringify(quiz), 'utf8').toString('base64url')} -->`;
}

export function decodeQuizMarker(body: string): Quiz | null {
  const m = new RegExp(`<!-- ${MARKER} ([A-Za-z0-9_-]+) -->`).exec(body);
  if (!m) return null;
  try {
    const q = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as Quiz;
    if (q.v !== 1 || !q.id || !Array.isArray(q.options)) return null;
    return q;
  } catch {
    return null;
  }
}
