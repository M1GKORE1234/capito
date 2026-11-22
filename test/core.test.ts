import { describe, expect, it } from 'vitest';
import { makeAiDetector } from '../src/core/ai-detect.js';
import { parseUnifiedDiff } from '../src/core/git.js';
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, globToRegExp, makeMatcher, splitList } from '../src/core/glob.js';
import { explain, renderGrade, renderMap, renderQuizBody } from '../src/core/i18n.js';
import { addEvent, emptyLedger, eventFromGrade, hasAnswered, parseLedger, serializeLedger } from '../src/core/ledger.js';
import { computeMap, heat, pickReviewFiles } from '../src/core/map.js';
import { applyMutant, findMutants, selectMutants } from '../src/core/mutate.js';
import { findMentionedFiles } from '../src/core/pipeline.js';
import { buildQuiz, decodeQuizMarker, encodeQuizMarker, gradeAnswer, openAnswers, parseCommand } from '../src/core/quiz.js';
import type { EvaluatedMutant } from '../src/core/runner.js';
import { deriveKey, pseudonym, seal, unseal } from '../src/core/seal.js';

const SRC = `import x from 'y';
type T = 1 | 2;
enum E { A = 1 }
export function discount(qty: number, vip: boolean): number {
  // >= in a comment must be ignored
  const s = "a >= b";
  if (qty >= 10 && !vip) return 0.1 * 2;
  let i = 0; i++;
  total += qty;
  const ok = !!vip;
  const label = 'n: ' + qty;
  return vip ? 0.2 : (qty as number) < 5 ? 0 : 0.05;
}
`;

describe('mutation engine', () => {
  const ms = findMutants('a.ts', SRC);

  it('finds realistic mutations and skips comments, strings, types and enums', () => {
    const summary = ms.map((m) => `${m.line}:${m.original}->${m.replacement}`);
    expect(summary).toContain('7:>=->>');
    expect(summary).toContain('7:&&->||');
    expect(summary).toContain('7:!->');
    expect(summary).toContain('8:++->--');
    expect(summary).toContain('9:+=->-=');
    expect(summary).toContain('12:<-><=');
    // nothing on the type alias, enum, comment, string or `!!`
    expect(ms.some((m) => m.line <= 6)).toBe(false);
    expect(ms.some((m) => m.line === 10)).toBe(false);
    // string concatenation is not mutated
    expect(ms.some((m) => m.line === 11)).toBe(false);
  });

  it('applies a mutation exactly at the token', () => {
    const m = ms.find((x) => x.original === '>=')!;
    const out = applyMutant(SRC, m);
    expect(out.split('\n')[6]).toBe('  if (qty > 10 && !vip) return 0.1 * 2;');
    expect(m.mutatedLine).toBe('  if (qty > 10 && !vip) return 0.1 * 2;');
    expect(m.column).toBe(11);
  });

  it('restricts to given lines', () => {
    const only = findMutants('a.ts', SRC, { lines: new Set([12]) });
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((m) => m.line === 12)).toBe(true);
  });

  it('handles JSX and broken files without throwing', () => {
    const jsx = findMutants('c.jsx', 'export const C = ({n}) => <div>{n > 1 ? "many" : "one"}</div>;');
    expect(jsx.map((m) => m.original)).toContain('>');
    expect(findMutants('broken.ts', 'function ( {{{')).toEqual([]);
  });

  it('selects a varied, bounded subset deterministically', () => {
    const a = selectMutants(ms, 4, 42);
    const b = selectMutants(ms, 4, 42);
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
    expect(a.length).toBe(4);
    expect(new Set(a.map((m) => m.line)).size).toBeGreaterThan(1);
  });
});

function evaluated(statuses: Array<'caught' | 'survived'>): EvaluatedMutant[] {
  const ms = findMutants('a.ts', SRC);
  const byLine = new Map<number, (typeof ms)[number]>();
  for (const m of ms) if (!byLine.has(m.line)) byLine.set(m.line, m);
  return [...byLine.values()].slice(0, statuses.length).map((m, i) => ({ ...m, status: statuses[i], durationMs: 10 }));
}

describe('quiz', () => {
  const key = deriveKey('secret', 'o/r', 's3cret');

  it('mixes caught and surviving changes and seals the answers', () => {
    const quiz = buildQuiz(evaluated(['caught', 'caught', 'survived', 'survived']), {
      count: 3,
      kind: 'pr',
      lang: 'en',
      key,
      keyMode: 'secret',
      testCommand: 'npm test',
      seed: 7,
    })!;
    expect(quiz.options.length).toBe(3);
    const answers = openAnswers(quiz, key)!;
    expect(answers.caught.length).toBeGreaterThanOrEqual(1);
    expect(answers.caught.length).toBeLessThanOrEqual(2);
    // the comment must not leak answers in clear text
    expect(JSON.stringify(quiz)).not.toContain('caught');
    // wrong key cannot open it
    expect(openAnswers(quiz, deriveKey('public', 'o/r'))).toBeNull();

    const grade = gradeAnswer(quiz, answers, answers.caught);
    expect(grade.perfect).toBe(true);
    const wrong = gradeAnswer(quiz, answers, []);
    expect(wrong.correctCount).toBe(3 - answers.caught.length);
  });

  it('refuses a copied quiz whose files or lines were edited', () => {
    const quiz = buildQuiz(evaluated(['caught', 'survived', 'caught']), { count: 3, kind: 'pr', lang: 'en', key, keyMode: 'secret', testCommand: 't' })!;
    expect(openAnswers(quiz, key)).not.toBeNull();
    const forged = { ...quiz, options: quiz.options.map((o, i) => (i === 0 ? { ...o, file: 'src/other.ts' } : o)) };
    expect(openAnswers(forged, key)).toBeNull();
    const relabelled = { ...quiz, options: quiz.options.map((o) => ({ ...o, line: o.line + 1 })) };
    expect(openAnswers(relabelled, key)).toBeNull();
  });

  it('returns null when there are fewer than two usable lines', () => {
    expect(buildQuiz(evaluated(['caught']), { count: 3, kind: 'pr', lang: 'en', key, keyMode: 'secret', testCommand: 't' })).toBeNull();
  });

  it('round-trips through the hidden comment marker, even with tricky code', () => {
    const quiz = buildQuiz(evaluated(['caught', 'survived', 'caught']), { count: 3, kind: 'digest', lang: 'it', key, keyMode: 'secret', testCommand: 't', sha: 'abc123' })!;
    quiz.options[0].originalLine = 'x --> y <!-- z';
    const body = renderQuizBody(quiz, { reason: 'Co-Authored-By: Claude' }, { repo: 'o/r' });
    const back = decodeQuizMarker(body)!;
    expect(back.id).toBe(quiz.id);
    expect(back.options[0].originalLine).toBe('x --> y <!-- z');
    expect(body).toContain('Quali di queste modifiche fanno fallire i test?');
    expect(body).toContain('https://github.com/o/r/blob/abc123/');
    // the marker is a single HTML comment whose payload cannot close it early
    expect(encodeQuizMarker(quiz).match(/-->/g)!.length).toBe(1);
  });

  it('parses answers and commands in English and Italian', () => {
    expect(parseCommand('/capito A C')).toEqual({ kind: 'answer', letters: ['A', 'C'] });
    expect(parseCommand('thanks!\n/capito a,c')).toEqual({ kind: 'answer', letters: ['A', 'C'] });
    expect(parseCommand('/capito A e C')).toEqual({ kind: 'answer', letters: ['A', 'C'] });
    expect(parseCommand('/capito b and a')).toEqual({ kind: 'answer', letters: ['A', 'B'] });
    expect(parseCommand('/capito nessuna')).toEqual({ kind: 'answer', letters: [] });
    expect(parseCommand('/capito none')).toEqual({ kind: 'answer', letters: [] });
    expect(parseCommand('/capito tutte')).toEqual({ kind: 'answer', letters: ['*'] });
    expect(parseCommand('/capito quiz src/cart.js')).toEqual({ kind: 'quiz', path: 'src/cart.js' });
    expect(parseCommand('/capito mappa')).toEqual({ kind: 'map' });
    expect(parseCommand('/capito')).toEqual({ kind: 'help' });
    expect(parseCommand('/capito maybe')).toEqual({ kind: 'invalid', text: 'maybe' });
    expect(parseCommand('no command here')).toBeNull();
    expect(parseCommand('see /capito A inline')).toBeNull();
  });

  it('renders a grade with test gaps', () => {
    const quiz = buildQuiz(evaluated(['caught', 'survived', 'survived']), { count: 3, kind: 'pr', lang: 'it', key, keyMode: 'secret', testCommand: 't', seed: 3 })!;
    const answers = openAnswers(quiz, key)!;
    const md = renderGrade(quiz, gradeAnswer(quiz, answers, ['A', 'B', 'C']), 'ada', {});
    expect(md).toContain('@ada');
    expect(md).toContain('Buco nei test');
  });
});

describe('seal', () => {
  it('encrypts and authenticates', () => {
    const k = deriveKey('secret', 'o/r', 'x');
    const s = seal({ a: 1 }, k);
    expect(unseal(s, k)).toEqual({ a: 1 });
    const tampered = s.slice(0, -2) + (s.endsWith('A') ? 'BB' : 'AA');
    expect(unseal(tampered, k)).toBeNull();
    expect(pseudonym('Ada', 'salt')).toBe(pseudonym('ada', 'salt'));
  });
});

describe('ledger and map', () => {
  it('records answers once per person and decays proofs over time', () => {
    const now = new Date('2026-11-22T12:00:00Z');
    let ledger = emptyLedger();
    const grade = {
      perOption: [
        { letter: 'A', file: 'src/a.ts', line: 3, operator: 'cmp-stricter' as const, caught: true, userSaidCaught: true, correct: true },
        { letter: 'B', file: 'src/a.ts', line: 9, operator: 'and-to-or' as const, caught: false, userSaidCaught: true, correct: false },
      ],
      correctCount: 1,
      total: 2,
      perfect: false,
    };
    ledger = addEvent(ledger, eventFromGrade('q1', 'pr', 'ada', grade, now));
    expect(hasAnswered(ledger, 'q1', 'ADA')).toBe(true);
    expect(hasAnswered(ledger, 'q1', 'bob')).toBe(false);
    ledger = parseLedger(serializeLedger(ledger));

    const stats = [
      { file: 'src/a.ts', totalLines: 100, aiLines: 40 },
      { file: 'src/b.ts', totalLines: 80, aiLines: 80 },
      { file: 'src/c.ts', totalLines: 50, aiLines: 0 },
      { file: 'src/d.ts', totalLines: 20, aiLines: 5 },
    ];
    const fresh = computeMap(stats, ledger, { now });
    const a = fresh.entries.find((e) => e.file === 'src/a.ts')!;
    // 1 of 2 options on that file right => half a proof; 40 AI lines need one proof
    expect(a.score).toBe(50);
    expect(a.people).toEqual(['ada']);
    expect(a.misconceptions).toBe(1);
    expect(fresh.entries.find((e) => e.file === 'src/b.ts')!.dark).toBe(true);
    // small files are never "dark"
    expect(fresh.entries.find((e) => e.file === 'src/d.ts')!.dark).toBe(false);
    expect(fresh.entries.some((e) => e.file === 'src/c.ts')).toBe(false);
    expect(fresh.index).toBe(Math.round((50 * 40) / 125));

    // 90 days later the proof is worth half
    const later = computeMap(stats, ledger, { now: new Date('2027-02-20T12:00:00Z') });
    expect(later.entries.find((e) => e.file === 'src/a.ts')!.score).toBe(25);

    // a perfect answer is one full proof, never more
    const perfect = addEvent(emptyLedger(), eventFromGrade('q2', 'pr', 'bob', { ...grade, perOption: grade.perOption.map((p) => ({ ...p, correct: true })), correctCount: 2, perfect: true }, now));
    expect(computeMap(stats, perfect, { now }).entries.find((e) => e.file === 'src/a.ts')!.score).toBe(100);
    expect(computeMap([{ file: 'src/a.ts', totalLines: 200, aiLines: 120 }], perfect, { now }).entries[0].score).toBe(33);

    expect(pickReviewFiles(fresh, 1)).toEqual(['src/b.ts']);
    const md = renderMap(fresh, 'en', { repo: 'o/r' });
    expect(md).toContain('Comprehension index');
    expect(md).toContain('Dark zones');
    expect(renderMap(fresh, 'it', {})).toContain('Zone buie');
  });

  // These three tests were added after Capito ran on its own code and found that
  // these boundaries survived mutation (see the README "Capito checks itself").
  it('uses exact boundaries for heat colours', () => {
    expect([heat(29), heat(30), heat(59), heat(60), heat(84), heat(85)]).toEqual(['🟥', '🟧', '🟧', '🟨', '🟨', '🟩']);
  });

  it('calls a file dark from exactly min-ai-lines AI lines', () => {
    const map = computeMap(
      [
        { file: 'a.ts', totalLines: 10, aiLines: 10 },
        { file: 'b.ts', totalLines: 9, aiLines: 9 },
      ],
      emptyLedger(),
    );
    expect(map.entries.find((e) => e.file === 'a.ts')!.dark).toBe(true);
    expect(map.entries.find((e) => e.file === 'b.ts')!.dark).toBe(false);
  });

  it('reviews half-understood files too, not only dark ones', () => {
    const now = new Date('2026-11-22T12:00:00Z');
    const half = { perOption: [{ letter: 'A', file: 'half.ts', line: 1, operator: 'eq-flip' as const, caught: true, userSaidCaught: true, correct: true }], correctCount: 1, total: 1, perfect: true };
    const ledger = addEvent(emptyLedger(), eventFromGrade('q', 'pr', 'ada', half, now));
    // 80 AI lines need 2 proofs: one proof => score 50 (not dark, but below 60)
    const map = computeMap([{ file: 'half.ts', totalLines: 80, aiLines: 80 }], ledger, { now });
    expect(map.entries[0].score).toBe(50);
    expect(map.entries[0].dark).toBe(false);
    expect(pickReviewFiles(map, 3)).toEqual(['half.ts']);
  });

  it('finds files mentioned in issues and stack traces', () => {
    const map = computeMap(
      [
        { file: 'src/billing/invoice.ts', totalLines: 50, aiLines: 50 },
        { file: 'src/index.ts', totalLines: 50, aiLines: 50 },
      ],
      emptyLedger(),
    );
    const hits = findMentionedFiles('Crash at invoice.ts:42 when total is 0. Also see src/index.ts', map.entries);
    expect(hits.map((h) => h.file).sort()).toEqual(['src/billing/invoice.ts', 'src/index.ts']);
    expect(findMentionedFiles('index.ts is fine', map.entries).map((h) => h.file)).toEqual([]);
  });
});

describe('ai detection', () => {
  const d = makeAiDetector(['^Vibe-Coded: yes']);
  it('recognises common agent fingerprints', () => {
    expect(d.isAiCommit({ sha: '1', message: 'fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' })).toMatch(/claude/i);
    expect(d.isAiCommit({ sha: '1', message: 'x\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>' })).toBeTruthy();
    expect(d.isAiCommit({ sha: '1', message: 'feat\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)' })).toBeTruthy();
    expect(d.isAiCommit({ sha: '1', message: 'init', authorLogin: 'copilot-swe-agent[bot]' })).toBeTruthy();
    expect(d.isAiCommit({ sha: '1', message: 'init', authorName: 'gpt-engineer-app[bot]' })).toBeTruthy();
    expect(d.isAiCommit({ sha: '1', message: 'x\n\nVibe-Coded: yes' })).toBeTruthy();
  });
  it('does not flag ordinary human commits', () => {
    expect(d.isAiCommit({ sha: '1', message: 'Fix cursor position in editor', authorName: 'Amp Rossi' })).toBeNull();
    expect(d.isAiCommit({ sha: '1', message: 'Co-authored-by: Mario Rossi <m@r.it>' })).toBeNull();
  });
});

describe('diff and globs', () => {
  it('parses unified diffs with zero context', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,0 +4,2 @@ x',
      '+a',
      '+b',
      '@@ -10 +12 @@',
      '-c',
      '+d',
      'diff --git a/old.ts b/old.ts',
      '--- a/old.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
    ].join('\n');
    const m = parseUnifiedDiff(diff);
    expect([...m.get('src/a.ts')!]).toEqual([4, 5, 12]);
    expect(m.has('old.ts')).toBe(false);
  });

  it('matches source files and excludes tests and build output', () => {
    const match = makeMatcher(DEFAULT_INCLUDE, DEFAULT_EXCLUDE);
    expect(match('src/cart.ts')).toBe(true);
    expect(match('cart.js')).toBe(true);
    expect(match('src/cart.test.ts')).toBe(false);
    expect(match('test/cart.js')).toBe(false);
    expect(match('node_modules/x/index.js')).toBe(false);
    expect(match('types/x.d.ts')).toBe(false);
    expect(match('vite.config.ts')).toBe(false);
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true);
    expect(splitList('src/**/*.{ts,tsx}, lib/**\n  app/*.js')).toEqual(['src/**/*.{ts,tsx}', 'lib/**', 'app/*.js']);
  });

  it('explains changes in plain language', () => {
    expect(explain('it', 'and-to-or', '&&', '||')).toContain('UNA');
    expect(explain('en', 'arith', '+', '-')).toBe('The operation changes from addition to subtraction.');
  });
});
