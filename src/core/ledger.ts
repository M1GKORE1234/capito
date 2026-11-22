import type { OperatorId } from './mutate.js';
import type { Grade, QuizKind } from './quiz.js';

/**
 * The ledger is Capito's memory: every answered question, who answered it,
 * and which lines of which files it was about. It is a plain JSON file that
 * lives on a dedicated branch (`capito-data`) of the same repository, so the
 * data stays with the code and needs no external service.
 */

export interface LedgerResult {
  file: string;
  line: number;
  operator: OperatorId;
  correct: boolean;
}

export interface LedgerEvent {
  quizId: string;
  kind: QuizKind;
  user: string;
  at: string;
  correct: number;
  total: number;
  results: LedgerResult[];
}

export interface Ledger {
  version: 1;
  events: LedgerEvent[];
}

/** Keeps the file well under 1 MB; older answers have decayed to almost nothing anyway. */
export const MAX_EVENTS = 2000;

export function emptyLedger(): Ledger {
  return { version: 1, events: [] };
}

export function parseLedger(text: string | null | undefined): Ledger {
  if (!text) return emptyLedger();
  try {
    const data = JSON.parse(text) as Ledger;
    if (data.version !== 1 || !Array.isArray(data.events)) return emptyLedger();
    return data;
  } catch {
    return emptyLedger();
  }
}

export function hasAnswered(ledger: Ledger, quizId: string, user: string): boolean {
  return ledger.events.some((e) => e.quizId === quizId && e.user.toLowerCase() === user.toLowerCase());
}

export function eventFromGrade(quizId: string, kind: QuizKind, user: string, grade: Grade, at = new Date()): LedgerEvent {
  return {
    quizId,
    kind,
    user,
    at: at.toISOString(),
    correct: grade.correctCount,
    total: grade.total,
    results: grade.perOption.map((p) => ({ file: p.file, line: p.line, operator: p.operator, correct: p.correct })),
  };
}

export function addEvent(ledger: Ledger, event: LedgerEvent): Ledger {
  const events = [...ledger.events, event];
  return { version: 1, events: events.slice(-MAX_EVENTS) };
}

/** Compact JSON with one event per line, so git diffs of the data branch stay readable. */
export function serializeLedger(ledger: Ledger): string {
  const events = ledger.events.map((e) => JSON.stringify(e)).join(',\n');
  return `{"version":1,"events":[${events ? '\n' + events + '\n' : ''}]}\n`;
}

/** Merge two ledgers (used when two answers are saved at the same moment). */
export function mergeLedgers(a: Ledger, b: Ledger): Ledger {
  const seen = new Set(a.events.map((e) => `${e.quizId}|${e.user.toLowerCase()}`));
  const extra = b.events.filter((e) => !seen.has(`${e.quizId}|${e.user.toLowerCase()}`));
  const events = [...a.events, ...extra].sort((x, y) => x.at.localeCompare(y.at));
  return { version: 1, events: events.slice(-MAX_EVENTS) };
}
