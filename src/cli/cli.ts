import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { makeAiDetector } from '../core/ai-detect.js';
import { aiLineStats } from '../core/blame.js';
import { changedLinesWorktree, tryGit } from '../core/git.js';
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, makeMatcher } from '../core/glob.js';
import { explain, messages, plural, renderMap } from '../core/i18n.js';
import { addEvent, eventFromGrade, parseLedger, serializeLedger, type Ledger } from '../core/ledger.js';
import { bar, computeMap, heat } from '../core/map.js';
import { generateQuiz } from '../core/pipeline.js';
import { gradeAnswer, openAnswers, parseCommand, type Lang } from '../core/quiz.js';
import { deriveKey } from '../core/seal.js';

const VERSION = '1.0.0';

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; flags: Flags } {
  const [cmd = 'help', ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const name = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { cmd, flags };
}

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
};

/** The project folder: the current directory, which must be inside a git repository. */
function repoRoot(): string {
  const root = tryGit(['rev-parse', '--show-toplevel'], process.cwd());
  if (!root) {
    console.error('capito: run this inside a git repository.');
    process.exit(2);
  }
  return process.cwd();
}

function defaultBase(cwd: string): string {
  const originHead = tryGit(['rev-parse', '--abbrev-ref', 'origin/HEAD'], cwd)?.trim();
  for (const ref of [originHead, 'origin/main', 'main', 'origin/master', 'master']) {
    if (!ref) continue;
    const mb = tryGit(['merge-base', ref, 'HEAD'], cwd)?.trim();
    const head = tryGit(['rev-parse', 'HEAD'], cwd)?.trim();
    if (mb && mb !== head) return mb;
  }
  return tryGit(['rev-parse', '--verify', 'HEAD~1'], cwd) ? 'HEAD~1' : 'HEAD';
}

function ledgerPath(cwd: string): string {
  return join(cwd, '.capito', 'ledger.json');
}

function loadLedger(cwd: string): Ledger {
  const p = ledgerPath(cwd);
  return parseLedger(existsSync(p) ? readFileSync(p, 'utf8') : null);
}

function saveLedger(cwd: string, ledger: Ledger): void {
  mkdirSync(join(cwd, '.capito'), { recursive: true });
  writeFileSync(ledgerPath(cwd), serializeLedger(ledger));
}

function langFrom(flags: Flags): Lang {
  const v = String(flags.lang ?? process.env.CAPITO_LANG ?? process.env.LANG ?? 'en').toLowerCase();
  return v.startsWith('it') ? 'it' : 'en';
}

async function cmdQuiz(flags: Flags): Promise<number> {
  const cwd = repoRoot();
  const lang = langFrom(flags);
  const it = lang === 'it';
  const testCommand = String(flags.test ?? 'npm test');
  const match = makeMatcher(DEFAULT_INCLUDE, DEFAULT_EXCLUDE);
  let lines: Map<string, Set<number>> | undefined;
  let files: string[] | undefined;
  if (typeof flags.file === 'string') {
    files = [flags.file.replace(/^\.\//, '')];
  } else {
    const base = typeof flags.base === 'string' ? flags.base : defaultBase(cwd);
    lines = new Map([...changedLinesWorktree(cwd, base)].filter(([f]) => match(f)));
    if (lines.size === 0) {
      console.log(it ? `Nessuna modifica a file JS/TS rispetto a ${base}. Prova: capito quiz --file src/qualcosa.ts` : `No JS/TS changes compared to ${base}. Try: capito quiz --file src/something.ts`);
      return 0;
    }
    console.log(c.dim(it ? `Confronto con ${base}: ${lines.size} file modificati` : `Comparing with ${base}: ${lines.size} changed file(s)`));
  }
  const key = deriveKey('public', cwd);
  console.log(c.dim(it ? `Eseguo i test su ogni modifica (${testCommand})...` : `Running the tests on each change (${testCommand})...`));
  const result = await generateQuiz({
    cwd,
    testCommand,
    lang,
    key,
    keyMode: 'public',
    kind: files ? 'on-demand' : 'pr',
    maxMutants: Number(flags['max-mutants'] ?? 8),
    optionsCount: Number(flags.options ?? 3),
    timeoutMs: flags['timeout-seconds'] ? Number(flags['timeout-seconds']) * 1000 : undefined,
    lines,
    files,
    seed: typeof flags.seed === 'string' ? flags.seed : undefined,
    log: flags.verbose ? (m) => console.log(c.dim(m)) : undefined,
  });
  if (!result.quiz) {
    const msg =
      result.status === 'baseline-failed'
        ? messages.baselineFailed(lang, testCommand)
        : result.status === 'no-mutants'
          ? messages.noMutants(lang, files?.[0])
          : messages.tooFewResults(lang);
    console.log(msg);
    if (result.status === 'baseline-failed' && result.baseline) console.log(c.dim(result.baseline.tail));
    return result.status === 'baseline-failed' ? 1 : 0;
  }
  const quiz = result.quiz;

  console.log('');
  console.log(c.bold(it ? '🧠 Capito? Quali di queste modifiche fanno fallire i test?' : '🧠 Capito? Which of these changes make your tests fail?'));
  console.log('');
  for (const o of quiz.options) {
    console.log(`${c.bold(o.letter)}  ${o.file}:${o.line}`);
    console.log(`   ${explain(lang, o.operator, o.original, o.replacement)}`);
    console.log(c.red(`   - ${o.originalLine.trim()}`));
    console.log(c.green(`   + ${o.mutatedLine.trim()}`));
    console.log('');
  }

  let answerText = typeof flags.answer === 'string' ? flags.answer : undefined;
  if (answerText === undefined) {
    if (!process.stdin.isTTY) {
      console.log(it ? 'Rispondi con --answer "A C" (oppure --answer nessuna).' : 'Answer with --answer "A C" (or --answer none).');
      return 0;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    answerText = await rl.question(it ? 'La tua risposta (es. "A C", oppure "nessuna"): ' : 'Your answer (e.g. "A C", or "none"): ');
    rl.close();
  }
  const cmd = parseCommand(`/capito ${answerText}`);
  if (!cmd || cmd.kind !== 'answer') {
    console.log(it ? 'Risposta non valida.' : 'Invalid answer.');
    return 1;
  }
  const answers = openAnswers(quiz, key)!;
  const grade = gradeAnswer(quiz, answers, cmd.letters);
  console.log('');
  const score = `${grade.correctCount}/${grade.total}`;
  console.log(grade.perfect ? c.green(c.bold(`✅ ${score} — Capito!`)) : grade.correctCount === 0 ? c.red(c.bold(`🔴 ${score}`)) : c.yellow(c.bold(`🟡 ${score}`)));
  for (const p of grade.perOption) {
    const reality = p.caught ? c.red(it ? 'i test falliscono' : 'tests fail') : c.green(it ? 'i test passano lo stesso' : 'tests still pass');
    console.log(`  ${p.correct ? '✔' : '✘'} ${p.letter}  ${p.file}:${p.line}  → ${reality}`);
  }
  const gaps = grade.perOption.filter((p) => !p.caught);
  if (gaps.length) {
    console.log('');
    console.log(
      it
        ? `🕳️  Buco nei test: ${gaps.map((g) => `${g.file}:${g.line}`).join(', ')}: nessun test se ne accorge.`
        : `🕳️  Gap in your tests: ${gaps.map((g) => `${g.file}:${g.line}`).join(', ')}: no test notices.`,
    );
  }
  const user = typeof flags.user === 'string' ? flags.user : (tryGit(['config', 'user.name'], cwd)?.trim() || 'me');
  saveLedger(cwd, addEvent(loadLedger(cwd), eventFromGrade(quiz.id, quiz.kind, user, grade)));
  console.log(c.dim(it ? `\nRegistrato in .capito/ledger.json (aggiungilo a .gitignore se non vuoi condividerlo).` : `\nRecorded in .capito/ledger.json (add it to .gitignore if you don't want to share it).`));
  return 0;
}

function cmdMap(flags: Flags): number {
  const cwd = repoRoot();
  const lang = langFrom(flags);
  const report = aiLineStats(cwd, {
    match: makeMatcher(DEFAULT_INCLUDE, DEFAULT_EXCLUDE),
    detector: makeAiDetector(),
    treatAllAsAi: Boolean(flags['all-ai']),
  });
  const ledger = loadLedger(cwd);
  const map = computeMap(report.stats, ledger);
  if (flags.json) {
    console.log(JSON.stringify(map, null, 2));
    return 0;
  }
  if (flags.write) {
    const md = renderMap(map, lang, { totalProofs: ledger.events.length, totalPeople: new Set(ledger.events.map((e) => e.user)).size, shallowWarning: report.shallow, noAiDetected: report.aiCommits === 0 });
    writeFileSync(join(cwd, 'CAPITO.md'), md);
    console.log(lang === 'it' ? 'Scritto CAPITO.md' : 'Wrote CAPITO.md');
  }
  const it = lang === 'it';
  if (map.filesWithAi === 0) {
    console.log(it ? "Nessun codice scritto dall'AI trovato (usa --all-ai se il codice viene da strumenti che non lasciano traccia)." : 'No AI-written code found (use --all-ai if your code comes from tools that leave no trace).');
    return 0;
  }
  console.log(c.bold(`${it ? 'Indice di comprensione' : 'Comprehension index'}: ${map.index}/100  ${bar(map.index, 20)}`));
  console.log(
    it
      ? `${map.aiLinesTotal} righe scritte dall'AI in ${plural(map.filesWithAi, lang, ['', ''], ['file', 'file'])} (${report.aiCommits} commit AI su ${report.totalCommits}) · ${plural(map.darkCount, lang, ['', ''], ['zona buia', 'zone buie'])}`
      : `${map.aiLinesTotal} AI-written lines in ${plural(map.filesWithAi, lang, ['file', 'files'], ['', ''])} (${plural(report.aiCommits, lang, ['AI commit', 'AI commits'], ['', ''])} of ${report.totalCommits}) · ${plural(map.darkCount, lang, ['dark zone', 'dark zones'], ['', ''])}`,
  );
  console.log('');
  for (const e of map.entries.slice(0, 30)) {
    console.log(`${heat(e.score)} ${bar(e.score)} ${String(e.score).padStart(3)}  ${String(e.aiLines).padStart(5)} ${it ? 'righe AI' : 'AI lines'}  ${e.file}${e.people.length ? c.dim('  ' + e.people.join(', ')) : ''}`);
  }
  if (map.darkCount) {
    console.log('');
    console.log(it ? `Inizia da qui: capito quiz --file ${map.entries[0].file}` : `Start here: capito quiz --file ${map.entries[0].file}`);
  }
  return 0;
}

function help(): number {
  console.log(`Capito ${VERSION} — measure and pay down comprehension debt in AI-written code

Usage:
  capito quiz [--base <ref> | --file <path>] [--test "<cmd>"] [--lang en|it] [--answer "A C"]
  capito map  [--lang en|it] [--write] [--json] [--all-ai]

quiz   Changes the code you (or your AI agent) just wrote in a few small ways,
       runs your tests on each version, and asks which changes they catch.
map    Shows which AI-written files somebody has proven to understand.

Options:
  --base <ref>         Compare with this ref (default: merge-base with main)
  --file <path>        Quiz on a whole file instead of the changed lines
  --test "<cmd>"       Test command (default: npm test)
  --lang en|it         Language (default: from $LANG)
  --max-mutants <n>    Changes to try (default: 8)
  --options <n>        Options per question, 2-4 (default: 3)
  --answer "<letters>" Answer without the interactive prompt
  --user <name>        Name recorded in .capito/ledger.json
  --all-ai             Treat every line as AI-written (map)
  --write              Write CAPITO.md (map)
  --json               Print the map as JSON

More: https://github.com/M1GKORE1234/capito`);
  return 0;
}

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  let code = 0;
  if (cmd === 'quiz') code = await cmdQuiz(flags);
  else if (cmd === 'map' || cmd === 'mappa') code = cmdMap(flags);
  else if (cmd === '--version' || cmd === 'version') console.log(VERSION);
  else code = help();
  process.exitCode = code;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
