import type { ComprehensionMap, MapEntry } from './map.js';
import { bar, heat } from './map.js';
import type { OperatorId } from './mutate.js';
import type { Grade, Lang, Quiz, QuizOption } from './quiz.js';
import { encodeQuizMarker } from './quiz.js';

export const PROJECT_URL = 'https://github.com/M1GKORE1234/capito';

export interface LinkContext {
  /** owner/repo, used to build links to files */
  repo?: string;
  serverUrl?: string;
}

function fileLink(o: { file: string; line: number }, sha: string | undefined, ctx: LinkContext): string {
  const label = `\`${o.file}:${o.line}\``;
  if (!ctx.repo || !sha) return label;
  const server = ctx.serverUrl ?? 'https://github.com';
  return `[${label}](${server}/${ctx.repo}/blob/${sha}/${encodePath(o.file)}#L${o.line})`;
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

const ARITH_NAMES: Record<Lang, Record<string, string>> = {
  en: { '+': 'addition', '-': 'subtraction', '*': 'multiplication', '/': 'division', '%': 'remainder', '+=': 'add', '-=': 'subtract', '*=': 'multiply', '/=': 'divide' },
  it: { '+': 'addizione', '-': 'sottrazione', '*': 'moltiplicazione', '/': 'divisione', '%': 'resto', '+=': 'aggiunge', '-=': 'toglie', '*=': 'moltiplica', '/=': 'divide' },
};

/** Plain-language description of a change, for people who do not read code fluently. */
export function explain(lang: Lang, op: OperatorId, original: string, replacement: string): string {
  const n = ARITH_NAMES[lang];
  if (lang === 'it') {
    switch (op) {
      case 'cmp-stricter':
        return 'Il confronto diventa più severo: quando i due valori sono uguali, ora dà la risposta opposta.';
      case 'cmp-looser':
        return 'Il confronto diventa più permissivo: quando i due valori sono uguali, ora dà la risposta opposta.';
      case 'eq-flip':
        return 'Il controllo di uguaglianza si inverte: «è uguale» diventa «è diverso» (o viceversa).';
      case 'and-to-or':
        return 'Ora basta UNA delle due condizioni, invece di ENTRAMBE.';
      case 'or-to-and':
        return 'Ora servono ENTRAMBE le condizioni, invece di una sola.';
      case 'arith':
        return `L'operazione cambia: da ${n[original] ?? original} a ${n[replacement] ?? replacement}.`;
      case 'assign-arith':
        return `La variabile viene aggiornata al contrario: invece di «${original}» fa «${replacement}».`;
      case 'bool-flip':
        return `Un valore «${original === 'true' ? 'vero' : 'falso'}» diventa «${replacement === 'true' ? 'vero' : 'falso'}».`;
      case 'drop-not':
        return 'Viene tolta la negazione «!», quindi la condizione si capovolge.';
      case 'num-plus-one':
        return `Il numero ${original} diventa ${replacement} (il classico errore «di uno»).`;
      case 'update-flip':
        return `Il contatore va nella direzione opposta («${original}» diventa «${replacement}»).`;
    }
  }
  switch (op) {
    case 'cmp-stricter':
      return 'The comparison becomes stricter: when both values are equal, it now gives the opposite answer.';
    case 'cmp-looser':
      return 'The comparison becomes looser: when both values are equal, it now gives the opposite answer.';
    case 'eq-flip':
      return 'The equality check is inverted: "is equal" becomes "is different" (or vice versa).';
    case 'and-to-or':
      return 'Now ONE of the two conditions is enough, instead of BOTH.';
    case 'or-to-and':
      return 'Now BOTH conditions are required, instead of just one.';
    case 'arith':
      return `The operation changes from ${n[original] ?? original} to ${n[replacement] ?? replacement}.`;
    case 'assign-arith':
      return `The variable is updated the opposite way: "${original}" becomes "${replacement}".`;
    case 'bool-flip':
      return `A ${original} value becomes ${replacement}.`;
    case 'drop-not':
      return 'The negation "!" is removed, so the condition is reversed.';
    case 'num-plus-one':
      return `The number ${original} becomes ${replacement} (the classic "off by one" error).`;
    case 'update-flip':
      return `The counter moves the other way ("${original}" becomes "${replacement}").`;
  }
}

function codeFence(o: QuizOption): string {
  const fence = o.originalLine.includes('```') || o.mutatedLine.includes('```') ? '````' : '```';
  return `${fence}diff\n- ${o.originalLine.trim()}\n+ ${o.mutatedLine.trim()}\n${fence}`;
}

export interface QuizIntro {
  /** Why we are asking: AI marker that was detected, file asked for, etc. */
  reason?: string;
  path?: string;
  mapIndex?: number;
  darkCount?: number;
}

export function renderQuizBody(quiz: Quiz, intro: QuizIntro, ctx: LinkContext): string {
  const it = quiz.lang === 'it';
  const n = quiz.options.length;
  const lines: string[] = [encodeQuizMarker(quiz)];
  if (quiz.kind === 'pr') {
    lines.push(it ? '### 🧠 Capito? 60 secondi per capire il codice di questa PR' : '### 🧠 Capito? A 60-second check on the code in this PR');
    const why = intro.reason ? (it ? ` (rilevato: \`${intro.reason}\`)` : ` (detected: \`${intro.reason}\`)`) : '';
    lines.push(
      it
        ? `Questa PR contiene codice scritto con l'AI${why}. Ho modificato il codice in ${n} piccoli modi e **ho eseguito i tuoi test** su ogni versione.`
        : `This PR contains AI-written code${why}. I changed the code in ${n} small ways and **ran your tests** on each version.`,
    );
  } else if (quiz.kind === 'digest') {
    lines.push(it ? '### 🧠 Le domande della settimana' : "### 🧠 This week's questions");
    lines.push(
      it
        ? `Vengono dalle zone meno capite del repository. Ho modificato il codice in ${n} piccoli modi e **ho eseguito i tuoi test** su ogni versione.`
        : `They come from the least understood parts of the repository. I changed the code in ${n} small ways and **ran your tests** on each version.`,
    );
  } else {
    lines.push(it ? `### 🧠 Capito? Quiz su \`${intro.path ?? 'questo codice'}\`` : `### 🧠 Capito? Quiz on \`${intro.path ?? 'this code'}\``);
    lines.push(
      it
        ? `Ho modificato il codice in ${n} piccoli modi e **ho eseguito i tuoi test** su ogni versione.`
        : `I changed the code in ${n} small ways and **ran your tests** on each version.`,
    );
  }
  lines.push('');
  lines.push(it ? '**Quali di queste modifiche fanno fallire i test?**' : '**Which of these changes make your tests fail?**');
  lines.push('');
  for (const o of quiz.options) {
    lines.push(`**${o.letter}** · ${fileLink(o, quiz.sha, ctx)} — ${explain(quiz.lang, o.operator, o.original, o.replacement)}`);
    lines.push(codeFence(o));
    lines.push('');
  }
  lines.push(
    it
      ? '**Rispondi** con un commento: `/capito A C` (le lettere delle modifiche che fanno fallire i test) oppure `/capito nessuna`.'
      : '**Answer** with a comment: `/capito A C` (the letters of the changes that make the tests fail) or `/capito none`.',
  );
  lines.push('');
  lines.push(
    it
      ? `<sub>Non blocca mai il merge. Le risposte giuste sono state calcolate eseguendo davvero \`${quiz.testCommand}\`, non indovinate da un'AI. · [Cos'è Capito?](${PROJECT_URL}/blob/main/README.it.md)</sub>`
      : `<sub>Never blocks merging. The right answers were computed by actually running \`${quiz.testCommand}\`, not guessed by an AI. · [What is Capito?](${PROJECT_URL})</sub>`,
  );
  return lines.join('\n');
}

export function renderGrade(quiz: Quiz, grade: Grade, user: string, ctx: LinkContext): string {
  const it = quiz.lang === 'it';
  const { correctCount: c, total: t } = grade;
  const lines: string[] = [];
  if (grade.perfect) {
    lines.push(it ? `✅ @${user} **${c}/${t} — Capito!** Hai letto questo codice come chi l'ha scritto.` : `✅ @${user} **${c}/${t} — Capito!** You read this code like its author.`);
  } else if (c === 0) {
    lines.push(it ? `🔴 @${user} **0/${t}.** La buona notizia: ora sai esattamente dove guardare.` : `🔴 @${user} **0/${t}.** The good news: now you know exactly where to look.`);
  } else {
    lines.push(it ? `🟡 @${user} **${c}/${t}.** Ecco cosa succede davvero:` : `🟡 @${user} **${c}/${t}.** Here is what really happens:`);
  }
  lines.push('');
  lines.push(it ? '| | Modifica | Hai detto | Cosa succede davvero |' : '| | Change | You said | What really happens |');
  lines.push('|---|---|---|---|');
  const fail = it ? 'i test falliscono' : 'tests fail';
  const pass = it ? 'i test passano lo stesso' : 'tests still pass';
  for (const p of grade.perOption) {
    const o = quiz.options.find((x) => x.letter === p.letter)!;
    const change = `${fileLink(o, quiz.sha, ctx)} \`${o.original || '!'}\` → \`${o.replacement || (it ? '(tolto)' : '(removed)')}\``;
    lines.push(`| ${p.correct ? '✔️' : '❌'} **${p.letter}** | ${change} | ${p.userSaidCaught ? fail : pass} | ${p.caught ? '🔴 ' + fail : '🟢 ' + pass} |`);
  }
  const survivors = grade.perOption.filter((p) => !p.caught);
  if (survivors.length) {
    lines.push('');
    const where = survivors.map((p) => {
      const o = quiz.options.find((x) => x.letter === p.letter)!;
      return `**${p.letter}** (${fileLink(o, quiz.sha, ctx)})`;
    });
    lines.push(
      it
        ? `🕳️ **Buco nei test:** ${where.join(', ')} ${survivors.length === 1 ? 'sopravvive' : 'sopravvivono'}: nessun test se ne accorge. Un test che controlli quel comportamento renderebbe il codice più sicuro, sia per te sia per il prossimo agente AI che lo modificherà.`
        : `🕳️ **Gap in your tests:** ${where.join(', ')} ${survivors.length === 1 ? 'survives' : 'survive'}: no test notices. A test for that behaviour would make this code safer, for you and for the next AI agent that edits it.`,
    );
  }
  const wrong = grade.perOption.filter((p) => !p.correct);
  if (wrong.length) {
    lines.push('');
    lines.push(it ? '**Da rileggere:**' : '**Worth a second look:**');
    for (const p of wrong) {
      const o = quiz.options.find((x) => x.letter === p.letter)!;
      lines.push(`- ${fileLink(o, quiz.sha, ctx)}: ${explain(quiz.lang, o.operator, o.original, o.replacement)}`);
    }
  }
  lines.push('');
  lines.push(
    it
      ? '<sub>Registrato nella mappa della comprensione. Conta solo la prima risposta di ogni persona.</sub>'
      : "<sub>Recorded in the comprehension map. Only each person's first answer counts.</sub>",
  );
  return lines.join('\n');
}

export const messages = {
  alreadyAnswered: (lang: Lang, user: string) =>
    lang === 'it'
      ? `@${user} hai già risposto a questo quiz (conta solo la prima risposta). Chiedine uno nuovo con \`/capito quiz\`.`
      : `@${user} you already answered this quiz (only the first answer counts). Ask for a new one with \`/capito quiz\`.`,
  noQuiz: (lang: Lang, user: string) =>
    lang === 'it'
      ? `@${user} non trovo un quiz di Capito in questa discussione. Chiedine uno con \`/capito quiz\` (in una PR) oppure \`/capito quiz percorso/del/file.ts\`.`
      : `@${user} I can't find a Capito quiz in this thread. Ask for one with \`/capito quiz\` (on a PR) or \`/capito quiz path/to/file.ts\`.`,
  invalid: (lang: Lang, user: string, text: string) =>
    lang === 'it'
      ? `@${user} non ho capito \`${text}\`. Rispondi con le lettere, per esempio \`/capito A C\`, oppure \`/capito nessuna\`.`
      : `@${user} I didn't understand \`${text}\`. Answer with letters, e.g. \`/capito A C\`, or \`/capito none\`.`,
  cannotGrade: (lang: Lang, user: string) =>
    lang === 'it'
      ? `@${user} non riesco a correggere questo quiz (forse \`CAPITO_SECRET\` è cambiato). Chiedine uno nuovo con \`/capito quiz\`.`
      : `@${user} I can't grade this quiz (maybe \`CAPITO_SECRET\` changed). Ask for a new one with \`/capito quiz\`.`,
  notAllowed: (lang: Lang, user: string) =>
    lang === 'it'
      ? `@${user} per sicurezza, i quiz su richiesta eseguono i test solo su branch di questo repository e solo per chi ha accesso in scrittura.`
      : `@${user} for safety, on-demand quizzes only run tests on branches of this repository and only for people with write access.`,
  noMutants: (lang: Lang, path?: string) =>
    lang === 'it'
      ? `Non ho trovato codice da trasformare in domande${path ? ` in \`${path}\`` : ''} (servono file JavaScript/TypeScript con un po' di logica).`
      : `I found no code to turn into questions${path ? ` in \`${path}\`` : ''} (Capito needs JavaScript/TypeScript files with some logic).`,
  baselineFailed: (lang: Lang, cmd: string) =>
    lang === 'it'
      ? `I test non passano sul codice attuale (\`${cmd}\`), quindi non posso calcolare le risposte giuste. Capito riproverà quando i test saranno verdi.`
      : `The tests fail on the current code (\`${cmd}\`), so I can't compute the right answers. Capito will try again once the tests are green.`,
  tooFewResults: (lang: Lang) =>
    lang === 'it'
      ? 'Ho eseguito i test, ma non ho abbastanza risultati utili per fare una domanda (servono almeno 2 modifiche su righe diverse).'
      : "I ran the tests but don't have enough usable results for a question (at least 2 changes on different lines are needed).",
  help: (lang: Lang) =>
    lang === 'it'
      ? [
          '**Comandi di Capito**',
          '- `/capito A C` — rispondi al quiz (le lettere delle modifiche che fanno fallire i test)',
          '- `/capito nessuna` — nessuna modifica fa fallire i test',
          '- `/capito quiz` — nuovo quiz sul codice di questa PR',
          '- `/capito quiz src/file.ts` — quiz su un file preciso',
          '- `/capito mappa` — la mappa della comprensione del repository',
          '',
          `<sub>[Guida completa](${PROJECT_URL}/blob/main/README.it.md)</sub>`,
        ].join('\n')
      : [
          '**Capito commands**',
          '- `/capito A C` — answer the quiz (letters of the changes that make tests fail)',
          '- `/capito none` — no change makes the tests fail',
          '- `/capito quiz` — new quiz on the code of this PR',
          '- `/capito quiz src/file.ts` — quiz on a specific file',
          "- `/capito map` — the repository's comprehension map",
          '',
          `<sub>[Full guide](${PROJECT_URL})</sub>`,
        ].join('\n'),
};

// ---------------------------------------------------------------------------
// Comprehension map rendering
// ---------------------------------------------------------------------------

/** "1 file" / "3 files", "1 persona" / "3 persone" */
export function plural(n: number, lang: Lang, en: [string, string], it: [string, string]): string {
  const [one, many] = lang === 'it' ? it : en;
  return `${n} ${n === 1 ? one : many}`;
}

function pct(a: number, b: number): number {
  return b ? Math.round((100 * a) / b) : 0;
}

function entryRow(e: MapEntry, lang: Lang, ctx: LinkContext, branch: string): string {
  const server = ctx.serverUrl ?? 'https://github.com';
  const link = ctx.repo ? `[\`${e.file}\`](${server}/${ctx.repo}/blob/${branch}/${encodePath(e.file)})` : `\`${e.file}\``;
  const who = e.people.length ? e.people.slice(0, 3).map((p) => (p.startsWith('anon-') ? p : `@${p}`)).join(' ') : lang === 'it' ? '— nessuno —' : '— nobody —';
  return `| ${heat(e.score)} | ${link} | ${e.aiLines} | \`${bar(e.score)}\` ${e.score} | ${who} |`;
}

export interface MapRenderOptions extends LinkContext {
  defaultBranch?: string;
  /** How many rows in the "all files" table */
  limit?: number;
  totalProofs?: number;
  totalPeople?: number;
  shallowWarning?: boolean;
  noAiDetected?: boolean;
}

export function renderMap(map: ComprehensionMap, lang: Lang, o: MapRenderOptions = {}): string {
  const it = lang === 'it';
  const branch = o.defaultBranch ?? 'main';
  const date = map.generatedAt.slice(0, 10);
  const L: string[] = [];
  L.push(it ? '# 🧠 Mappa della comprensione' : '# 🧠 Comprehension map');
  L.push('');
  L.push(
    it
      ? `> Quanta parte del codice scritto dall'AI in questo repository è stata davvero capita da almeno una persona? Aggiornata il ${date} da [Capito](${PROJECT_URL}).`
      : `> How much of the AI-written code in this repository has at least one person demonstrably understood? Updated ${date} by [Capito](${PROJECT_URL}).`,
  );
  L.push('');
  if (o.shallowWarning) {
    L.push(
      it
        ? '> ⚠️ Il repository è stato scaricato senza storia completa: usa `fetch-depth: 0` in `actions/checkout` per un\'attribuzione corretta.'
        : '> ⚠️ The repository was checked out without full history: use `fetch-depth: 0` in `actions/checkout` for correct attribution.',
    );
    L.push('');
  }
  if (map.filesWithAi === 0) {
    L.push(
      o.noAiDetected
        ? it
          ? "Non ho trovato commit scritti dall'AI. Se il tuo codice viene da strumenti che non lasciano traccia (Lovable, Bolt, chat copiate...), imposta `treat-all-as-ai: true`."
          : 'No AI-written commits found. If your code comes from tools that leave no trace (Lovable, Bolt, copy-pasted chats...), set `treat-all-as-ai: true`.'
        : it
          ? 'Nessun file con codice scritto dall\'AI.'
          : 'No files with AI-written code.',
    );
    return L.join('\n') + '\n';
  }
  L.push(it ? `## Indice di comprensione: **${map.index}/100** \`${bar(map.index, 20)}\`` : `## Comprehension index: **${map.index}/100** \`${bar(map.index, 20)}\``);
  L.push('');
  L.push(
    it
      ? `- **${map.aiLinesTotal}** righe scritte dall'AI su ${map.linesTotal} (${pct(map.aiLinesTotal, map.linesTotal)}%), in ${plural(map.filesWithAi, lang, ['file', 'files'], ['file', 'file'])}`
      : `- **${map.aiLinesTotal}** AI-written lines out of ${map.linesTotal} (${pct(map.aiLinesTotal, map.linesTotal)}%), in ${plural(map.filesWithAi, lang, ['file', 'files'], ['file', 'file'])}`,
  );
  L.push(
    it
      ? `- **${map.darkCount}** ${map.darkCount === 1 ? 'zona buia' : 'zone buie'}: ${map.darkLines} righe scritte dall'AI che nessuno ha ancora dimostrato di capire`
      : `- **${map.darkCount}** ${map.darkCount === 1 ? 'dark zone' : 'dark zones'}: ${map.darkLines} AI-written lines nobody has yet shown they understand`,
  );
  if (o.totalProofs !== undefined) {
    const people = plural(o.totalPeople ?? 0, lang, ['person', 'people'], ['persona', 'persone']);
    L.push(it ? `- **${plural(o.totalProofs, lang, ['', ''], ['risposta registrata', 'risposte registrate'])}** da ${people}` : `- **${plural(o.totalProofs, lang, ['answer', 'answers'], ['', ''])}** recorded from ${people}`);
  }
  L.push('');
  const header = it ? '| | File | Righe AI | Capito | Chi lo capisce |' : '| | File | AI lines | Understood | Who understands it |';
  const dark = map.entries.filter((e) => e.dark);
  if (dark.length) {
    L.push(it ? '## 🌑 Zone buie (inizia da qui)' : '## 🌑 Dark zones (start here)');
    L.push('');
    L.push(header);
    L.push('|---|---|---:|---|---|');
    for (const e of dark.slice(0, 15)) L.push(entryRow(e, lang, o, branch));
    L.push('');
    L.push(it ? 'Per illuminarne una, commenta in una issue o PR: `/capito quiz percorso/del/file`.' : 'To light one up, comment on any issue or PR: `/capito quiz path/to/file`.');
    L.push('');
  }
  const limit = o.limit ?? 50;
  L.push(it ? '## Tutti i file con codice AI' : '## All files with AI code');
  L.push('');
  L.push(header);
  L.push('|---|---|---:|---|---|');
  for (const e of map.entries.slice(0, limit)) L.push(entryRow(e, lang, o, branch));
  if (map.entries.length > limit) L.push(it ? `| | … e altri ${map.entries.length - limit} file | | | |` : `| | … and ${map.entries.length - limit} more files | | | |`);
  L.push('');
  L.push(it ? '## Come si calcola' : '## How it is calculated');
  L.push('');
  L.push(
    it
      ? `Ogni risposta giusta a un quiz è una «prova» che qualcuno capisce quel file. Le prove perdono metà del valore ogni ${map.options.halfLifeDays} giorni, perché anche la comprensione svanisce. Un file è capito al 100% quando ha almeno una prova recente ogni ${map.options.linesPerProof} righe scritte dall'AI. È una **zona buia** se ha almeno ${map.options.minAiLines} righe AI e un punteggio sotto ${map.options.darkThreshold}. Le righe AI vengono dai commit con firme come \`Co-Authored-By: Claude\` o \`Copilot\`.`
      : `Every correct quiz answer is a "proof" that someone understands that file. Proofs lose half their value every ${map.options.halfLifeDays} days, because understanding fades too. A file is 100% understood when it has at least one recent proof every ${map.options.linesPerProof} AI-written lines. It is a **dark zone** if it has at least ${map.options.minAiLines} AI lines and a score below ${map.options.darkThreshold}. AI lines come from commits with signatures like \`Co-Authored-By: Claude\` or \`Copilot\`.`,
  );
  L.push('');
  L.push(`🟥 0–29 · 🟧 30–59 · 🟨 60–84 · 🟩 85–100`);
  return L.join('\n') + '\n';
}

/** Short version for comments and the weekly issue. */
export function renderMapSummary(map: ComprehensionMap, lang: Lang, o: MapRenderOptions & { mapUrl?: string } = {}): string {
  const it = lang === 'it';
  if (map.filesWithAi === 0) return it ? "Nessun codice scritto dall'AI rilevato." : 'No AI-written code detected.';
  const L: string[] = [];
  L.push(it ? `**Indice di comprensione: ${map.index}/100** \`${bar(map.index, 20)}\`` : `**Comprehension index: ${map.index}/100** \`${bar(map.index, 20)}\``);
  L.push('');
  L.push(
    it
      ? `${map.aiLinesTotal} righe scritte dall'AI in ${plural(map.filesWithAi, lang, ['', ''], ['file', 'file'])} · **${plural(map.darkCount, lang, ['', ''], ['zona buia', 'zone buie'])}** (${map.darkLines} righe)`
      : `${map.aiLinesTotal} AI-written lines in ${plural(map.filesWithAi, lang, ['file', 'files'], ['', ''])} · **${plural(map.darkCount, lang, ['dark zone', 'dark zones'], ['', ''])}** (${map.darkLines} lines)`,
  );
  const top = map.entries.slice(0, 5);
  if (top.length) {
    L.push('');
    L.push(it ? '| | File | Righe AI | Capito | Chi lo capisce |' : '| | File | AI lines | Understood | Who understands it |');
    L.push('|---|---|---:|---|---|');
    for (const e of top) L.push(entryRow(e, lang, o, o.defaultBranch ?? 'main'));
  }
  if (o.mapUrl) {
    L.push('');
    L.push(it ? `[Mappa completa →](${o.mapUrl})` : `[Full map →](${o.mapUrl})`);
  }
  return L.join('\n');
}

export function renderDigestIssue(map: ComprehensionMap, quizBody: string | null, lang: Lang, o: MapRenderOptions & { mapUrl?: string; note?: string }): { title: string; body: string } {
  const it = lang === 'it';
  const date = map.generatedAt.slice(0, 10);
  const title = it ? `🧠 Capito — ripasso della settimana (${date})` : `🧠 Capito — weekly review (${date})`;
  const L: string[] = [];
  L.push(
    it
      ? "5 minuti per illuminare gli angoli più bui del codice scritto dall'AI. Rispondi qui sotto: conta per la mappa della comprensione."
      : 'Five minutes to light up the darkest corners of the AI-written code. Answer below: it counts towards the comprehension map.',
  );
  L.push('');
  if (quizBody) {
    L.push(quizBody);
  } else if (o.note) {
    L.push(`> ${o.note}`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push(renderMapSummary(map, lang, o));
  return { title, body: L.join('\n') };
}

export function renderAlert(entries: MapEntry[], lang: Lang, relatedTests: Map<string, string[]>, ctx: LinkContext & { defaultBranch?: string }): string {
  const it = lang === 'it';
  const L: string[] = [];
  const total = entries.reduce((n, e) => n + e.aiLines, 0);
  L.push(it ? '⚠️ **Zona buia in vista.**' : '⚠️ **Dark zone ahead.**');
  L.push('');
  L.push(
    it
      ? `Questa issue tocca codice scritto dall'AI che nessuno ha ancora dimostrato di capire (${total} righe):`
      : `This issue touches AI-written code that nobody has yet shown they understand (${total} lines):`,
  );
  L.push('');
  for (const e of entries) {
    const tests = relatedTests.get(e.file) ?? [];
    const testsTxt = tests.length ? (it ? ` · test collegati: ${tests.map((t) => `\`${t}\``).join(', ')}` : ` · related tests: ${tests.map((t) => `\`${t}\``).join(', ')}`) : it ? ' · nessun test collegato trovato' : ' · no related tests found';
    L.push(`- ${heat(e.score)} \`${e.file}\` — ${e.aiLines} ${it ? 'righe AI' : 'AI lines'}, ${it ? 'capito' : 'understood'} ${e.score}/100${testsTxt}`);
  }
  L.push('');
  L.push(
    it
      ? `Prima di correggere, prenditi 60 secondi: commenta \`/capito quiz ${entries[0].file}\`. Chi capisce il codice prima di toccarlo introduce meno regressioni, ed è anche il modo migliore per spiegare il problema a un agente AI.`
      : `Before fixing it, take 60 seconds: comment \`/capito quiz ${entries[0].file}\`. Understanding the code before touching it means fewer regressions, and it is also the best way to explain the problem to an AI agent.`,
  );
  return L.join('\n');
}
