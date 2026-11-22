import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeAiDetector } from '../core/ai-detect.js';
import { aiLineStats } from '../core/blame.js';
import { changedLines, git, listTrackedFiles, prDiffBase, tryGit } from '../core/git.js';
import { makeMatcher } from '../core/glob.js';
import { messages, renderAlert, renderDigestIssue, renderGrade, renderMap, renderMapSummary, renderQuizBody, type LinkContext } from '../core/i18n.js';
import { eventFromGrade, type Ledger } from '../core/ledger.js';
import { computeMap, pickReviewFiles, type ComprehensionMap } from '../core/map.js';
import { findMentionedFiles, generateQuiz, relatedTests, TEST_FILE_RE, type GenerateResult } from '../core/pipeline.js';
import { decodeQuizMarker, gradeAnswer, openAnswers, parseCommand, type Lang, type Quiz } from '../core/quiz.js';
import { deriveKey, pseudonym, type KeyMode } from '../core/seal.js';
import { GitHubError, type Api, type Comment } from './api.js';
import { DataStore } from './store.js';

export interface Config {
  testCommand: string;
  lang: Lang;
  secret?: string;
  maxMutants: number;
  optionsCount: number;
  timeoutMs?: number;
  aiOnly: boolean;
  aiMarkers: string[];
  include: string[];
  exclude: string[];
  halfLifeDays: number;
  linesPerProof: number;
  minAiLines: number;
  darkThreshold: number;
  dataBranch: string;
  anonymous: boolean;
  digestFiles: number;
  treatAllAsAi: boolean;
  alertOnIssues: boolean;
  includeDrafts: boolean;
  mode: 'auto' | 'digest' | 'map';
}

export interface Logger {
  info(msg: string): void;
  warning(msg: string): void;
}

export interface Context {
  eventName: string;
  // GitHub webhook payloads are large and loosely typed; we read only a few fields
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any;
  repo: string;
  cwd: string;
  serverUrl: string;
  sha?: string;
  api: Api;
  config: Config;
  log: Logger;
  summary(markdown: string): void;
  output(name: string, value: string | number): void;
}

export interface Outcome {
  action:
    | 'quiz-posted'
    | 'quiz-in-summary'
    | 'graded'
    | 'duplicate'
    | 'replied'
    | 'alerted'
    | 'digest-created'
    | 'map-updated'
    | 'skipped';
  reason?: string;
  quizId?: string;
  issue?: number;
}

const skip = (reason: string): Outcome => ({ action: 'skipped', reason });
const DIGEST_LABEL = 'capito-digest';

function linkCtx(ctx: Context): LinkContext {
  return { repo: ctx.repo, serverUrl: ctx.serverUrl };
}

function keyFor(ctx: Context, mode: KeyMode): Buffer {
  return deriveKey(mode, ctx.repo, ctx.config.secret);
}

function defaultBranch(ctx: Context): string {
  return ctx.event?.repository?.default_branch ?? 'main';
}

export async function run(ctx: Context): Promise<Outcome> {
  const { eventName } = ctx;
  if (ctx.config.mode === 'digest') return handleDigest(ctx);
  if (ctx.config.mode === 'map') return handleMap(ctx);
  switch (eventName) {
    case 'pull_request':
      return handlePullRequest(ctx);
    case 'pull_request_target':
      ctx.log.warning('Capito does not run on pull_request_target: it would execute untrusted fork code with write access. Use the pull_request event.');
      return skip('pull_request_target is not supported');
    case 'issue_comment':
      return handleComment(ctx);
    case 'issues':
      return handleIssue(ctx);
    case 'schedule':
    case 'workflow_dispatch':
      return handleDigest(ctx);
    case 'push': {
      const ref: string = ctx.event?.ref ?? '';
      if (ref === `refs/heads/${defaultBranch(ctx)}`) return handleMap(ctx);
      return skip('push to a non-default branch');
    }
    default:
      return skip(`event ${eventName} is not used by Capito`);
  }
}

// ---------------------------------------------------------------------------
// Pull requests: ask a question about the AI-written changes
// ---------------------------------------------------------------------------

/**
 * The most recent quiz in a thread.
 * Quizzes sealed with the repository secret are authenticated (they cannot be forged or edited),
 * so they are accepted from any author, e.g. when the workflow uses a personal access token.
 * Quizzes sealed with the public key are only trusted when posted by a bot.
 */
function latestQuiz(thread: Array<{ body: string | null; user: { type: string } | null }>): Quiz | null {
  let found: Quiz | null = null;
  for (const c of thread) {
    if (!c.body) continue;
    const q = decodeQuizMarker(c.body);
    if (!q) continue;
    if (q.keyMode === 'secret' || c.user?.type === 'Bot') found = q;
  }
  return found;
}

async function handlePullRequest(ctx: Context): Promise<Outcome> {
  const { event, config, api, log } = ctx;
  const pr = event.pull_request;
  const action: string = event.action;
  if (!['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(action)) return skip(`pull_request.${action}`);
  if (pr.draft && !config.includeDrafts) return skip('draft pull request (Capito asks when it is ready for review)');

  let comments: Comment[] = [];
  try {
    comments = await api.listIssueComments(pr.number);
  } catch {
    /* forks may not be able to read; continue */
  }
  if (latestQuiz(comments)) return skip('this pull request already has a Capito quiz (ask for a new one with /capito quiz)');

  // 1. Is there AI-written code in this PR?
  const detector = makeAiDetector(config.aiMarkers);
  let reason: string | null = null;
  try {
    const commits = await api.listPullCommits(pr.number);
    for (const c of commits) {
      reason = detector.isAiCommit({
        sha: c.sha,
        message: c.commit.message,
        authorName: c.commit.author?.name,
        authorEmail: c.commit.author?.email,
        committerName: c.commit.committer?.name,
        authorLogin: c.author?.login,
      });
      if (reason) break;
    }
  } catch (e) {
    log.warning(`Could not list PR commits: ${String(e)}`);
  }
  if (!reason && pr.user?.login) reason = detector.isAiCommit({ sha: '', message: '', authorLogin: pr.user.login });
  if (!reason && config.treatAllAsAi) reason = 'treat-all-as-ai';
  if (!reason && config.aiOnly) {
    ctx.summary('🧠 **Capito**: no AI-written commits in this pull request, nothing to ask.');
    return skip('no AI-written commits');
  }

  // 2. Which source lines did it change?
  const match = makeMatcher(config.include, config.exclude);
  const base = prDiffBase(ctx.cwd, pr.base?.sha);
  const lines = new Map([...changedLines(ctx.cwd, base)].filter(([f]) => match(f)));
  if (lines.size === 0) {
    ctx.summary('🧠 **Capito**: no JavaScript/TypeScript source changes to ask about.');
    return skip('no source changes');
  }

  // 3. Mutate, run the tests, build the question
  const keyMode: KeyMode = config.secret ? 'secret' : 'public';
  const result = await generateQuiz({
    cwd: ctx.cwd,
    testCommand: config.testCommand,
    lang: config.lang,
    key: keyFor(ctx, keyMode),
    keyMode,
    kind: 'pr',
    maxMutants: config.maxMutants,
    optionsCount: config.optionsCount,
    timeoutMs: config.timeoutMs,
    lines,
    sha: ctx.sha ?? pr.head?.sha,
    seed: `${ctx.repo}#${pr.number}`,
    log: log.info,
  });
  if (!result.quiz) return explainNoQuiz(ctx, result, null);

  const body = renderQuizBody(result.quiz, { reason: reason ?? undefined }, linkCtx(ctx));
  ctx.output('quiz-id', result.quiz.id);
  try {
    await api.createComment(pr.number, body);
    ctx.summary(`🧠 **Capito** asked a question on #${pr.number} (quiz \`${result.quiz.id}\`).`);
    return { action: 'quiz-posted', quizId: result.quiz.id };
  } catch (e) {
    if (e instanceof GitHubError && e.status === 403) {
      // Pull requests from forks get a read-only token
      log.warning('Cannot comment (read-only token, probably a fork). The quiz is in the job summary.');
      ctx.summary(body);
      return { action: 'quiz-in-summary', quizId: result.quiz.id };
    }
    throw e;
  }
}

function explainNoQuiz(ctx: Context, result: GenerateResult, replyTo: number | null, path?: string): Outcome | Promise<Outcome> {
  const lang = ctx.config.lang;
  const text =
    result.status === 'baseline-failed'
      ? messages.baselineFailed(lang, ctx.config.testCommand)
      : result.status === 'no-mutants'
        ? messages.noMutants(lang, path)
        : messages.tooFewResults(lang);
  ctx.summary(`🧠 **Capito**: ${text}`);
  if (result.status === 'baseline-failed') ctx.log.warning(`Baseline tests failed. Last output:\n${result.baseline?.tail ?? ''}`);
  if (replyTo !== null) {
    return ctx.api.createComment(replyTo, text).then(() => ({ action: 'replied', reason: result.status }) as Outcome);
  }
  return skip(result.status);
}

// ---------------------------------------------------------------------------
// Comments: /capito answers and commands
// ---------------------------------------------------------------------------

async function handleComment(ctx: Context): Promise<Outcome> {
  const { event, api, config } = ctx;
  if (event.action !== 'created') return skip('comment edited or deleted');
  const comment = event.comment;
  if (!comment?.body || comment.user?.type === 'Bot') return skip('comment by a bot');
  const cmd = parseCommand(comment.body);
  if (!cmd) return skip('no /capito command');
  const issue = event.issue;
  const number: number = issue.number;
  const user: string = comment.user.login;

  if (cmd.kind === 'help') {
    await api.createComment(number, messages.help(config.lang));
    return { action: 'replied', reason: 'help' };
  }
  if (cmd.kind === 'invalid') {
    await api.createComment(number, messages.invalid(config.lang, user, cmd.text));
    return { action: 'replied', reason: 'invalid' };
  }
  if (cmd.kind === 'map') return replyWithMap(ctx, number);
  if (cmd.kind === 'quiz') return onDemandQuiz(ctx, number, Boolean(issue.pull_request), user, comment.id, cmd.path);

  // An answer: find the most recent quiz in this thread (issue body first, then comments)
  const comments = (await api.listIssueComments(number)).filter((c) => c.id !== comment.id);
  const quiz = latestQuiz([{ body: issue.body, user: issue.user }, ...comments]);
  if (!quiz) {
    await api.createComment(number, messages.noQuiz(config.lang, user));
    return { action: 'replied', reason: 'no quiz' };
  }
  if (quiz.keyMode === 'secret' && !config.secret) {
    await api.createComment(number, messages.cannotGrade(quiz.lang, user));
    return { action: 'replied', reason: 'missing secret' };
  }
  const answers = openAnswers(quiz, keyFor(ctx, quiz.keyMode));
  if (!answers) {
    await api.createComment(number, messages.cannotGrade(quiz.lang, user));
    return { action: 'replied', reason: 'cannot decrypt' };
  }
  const grade = gradeAnswer(quiz, answers, cmd.letters);
  const who = config.anonymous ? pseudonym(user, ctx.repo) : user;
  const store = new DataStore(api, config.dataBranch);
  let saved: 'saved' | 'duplicate' | 'failed' = 'failed';
  try {
    saved = await store.appendEvent(eventFromGrade(quiz.id, quiz.kind, who, grade));
  } catch (e) {
    ctx.log.warning(`Could not record the answer on branch ${config.dataBranch} (does the workflow have "contents: write"?): ${String(e)}`);
  }
  if (saved === 'duplicate') {
    await api.createComment(number, messages.alreadyAnswered(quiz.lang, user));
    return { action: 'duplicate', quizId: quiz.id };
  }
  await api.createComment(number, renderGrade(quiz, grade, user, linkCtx(ctx)));
  await api.addReaction(comment.id, grade.perfect ? 'rocket' : '+1');
  ctx.summary(`🧠 **Capito**: graded @${user} on quiz \`${quiz.id}\`: ${grade.correctCount}/${grade.total}.`);
  return { action: 'graded', quizId: quiz.id };
}

async function canRunCode(ctx: Context, user: string): Promise<boolean> {
  const perm = await ctx.api.getPermission(user);
  return ['admin', 'maintain', 'write'].includes(perm);
}

async function onDemandQuiz(ctx: Context, number: number, isPr: boolean, user: string, commentId: number, path?: string): Promise<Outcome> {
  const { api, config } = ctx;
  // Running a quiz executes code: only for people who could push that code anyway
  if (!(await canRunCode(ctx, user))) {
    await api.createComment(number, messages.notAllowed(config.lang, user));
    return { action: 'replied', reason: 'not allowed' };
  }
  await api.addReaction(commentId, 'eyes');
  const match = makeMatcher(config.include, config.exclude);
  const keyMode: KeyMode = config.secret ? 'secret' : 'public';
  const originalHead = (tryGit(['rev-parse', 'HEAD'], ctx.cwd) ?? '').trim();
  let lines: Map<string, Set<number>> | undefined;
  let files: string[] | undefined;
  let sha = ctx.sha;
  try {
    if (isPr) {
      const pr = await api.getPull(number);
      if (pr.head.repo?.full_name?.toLowerCase() !== ctx.repo.toLowerCase()) {
        await api.createComment(number, messages.notAllowed(config.lang, user));
        return { action: 'replied', reason: 'fork pull request' };
      }
      git(['fetch', '--no-tags', 'origin', `+refs/pull/${number}/head:refs/remotes/capito/pr-${number}`], ctx.cwd);
      tryGit(['fetch', '--no-tags', 'origin', pr.base.sha], ctx.cwd);
      git(['checkout', '--detach', '--force', `refs/remotes/capito/pr-${number}`], ctx.cwd);
      sha = pr.head.sha;
      if (!path) {
        const base = (tryGit(['merge-base', pr.base.sha, 'HEAD'], ctx.cwd) ?? pr.base.sha).trim();
        lines = new Map([...changedLines(ctx.cwd, base)].filter(([f]) => match(f)));
      }
    }
    if (path) {
      const clean = path.replace(/^\.?\//, '');
      if (!existsSync(join(ctx.cwd, clean))) {
        await api.createComment(number, messages.noMutants(config.lang, clean));
        return { action: 'replied', reason: 'file not found' };
      }
      files = [clean];
    } else if (!lines) {
      const { map } = await computeRepoMap(ctx);
      files = pickReviewFiles(map, config.digestFiles);
      if (files.length === 0) {
        await api.createComment(number, messages.noMutants(config.lang));
        return { action: 'replied', reason: 'nothing dark' };
      }
    }
    const result = await generateQuiz({
      cwd: ctx.cwd,
      testCommand: config.testCommand,
      lang: config.lang,
      key: keyFor(ctx, keyMode),
      keyMode,
      kind: 'on-demand',
      maxMutants: config.maxMutants,
      optionsCount: config.optionsCount,
      timeoutMs: config.timeoutMs,
      lines,
      files,
      sha,
      seed: `${ctx.repo}#${number}#${commentId}`,
      log: ctx.log.info,
    });
    if (!result.quiz) return await explainNoQuiz(ctx, result, number, path);
    await api.createComment(number, renderQuizBody(result.quiz, { path: path ?? (files ? files.join(', ') : undefined) }, linkCtx(ctx)));
    ctx.output('quiz-id', result.quiz.id);
    return { action: 'quiz-posted', quizId: result.quiz.id };
  } finally {
    if (isPr && originalHead) tryGit(['checkout', '--detach', '--force', originalHead], ctx.cwd);
  }
}

// ---------------------------------------------------------------------------
// The comprehension map
// ---------------------------------------------------------------------------

async function computeRepoMap(ctx: Context): Promise<{ map: ComprehensionMap; ledger: Ledger; shallow: boolean; aiCommits: number }> {
  const { config } = ctx;
  const report = aiLineStats(ctx.cwd, {
    match: makeMatcher(config.include, config.exclude),
    detector: makeAiDetector(config.aiMarkers),
    treatAllAsAi: config.treatAllAsAi,
    log: ctx.log.info,
  });
  if (report.shallow) ctx.log.warning('Shallow clone detected: use `fetch-depth: 0` in actions/checkout so Capito can see who wrote each line.');
  let ledger: Ledger = { version: 1, events: [] };
  try {
    ledger = (await new DataStore(ctx.api, config.dataBranch).readLedger()).ledger;
  } catch (e) {
    ctx.log.warning(`Could not read the ledger: ${String(e)}`);
  }
  const map = computeMap(report.stats, ledger, {
    halfLifeDays: config.halfLifeDays,
    linesPerProof: config.linesPerProof,
    minAiLines: config.minAiLines,
    darkThreshold: config.darkThreshold,
  });
  ctx.output('comprehension-index', map.index);
  ctx.output('dark-zones', map.darkCount);
  return { map, ledger, shallow: report.shallow, aiCommits: report.aiCommits };
}

function mapRenderOptions(ctx: Context, ledger: Ledger, shallow: boolean, aiCommits: number) {
  return {
    ...linkCtx(ctx),
    defaultBranch: defaultBranch(ctx),
    totalProofs: ledger.events.length,
    totalPeople: new Set(ledger.events.map((e) => e.user.toLowerCase())).size,
    shallowWarning: shallow,
    noAiDetected: aiCommits === 0,
    mapUrl: `${ctx.serverUrl}/${ctx.repo}/blob/${ctx.config.dataBranch}/CAPITO.md`,
  };
}

async function publishMap(ctx: Context, map: ComprehensionMap, ledger: Ledger, shallow: boolean, aiCommits: number): Promise<boolean> {
  const o = mapRenderOptions(ctx, ledger, shallow, aiCommits);
  const md = renderMap(map, ctx.config.lang, o);
  ctx.summary(md);
  try {
    await new DataStore(ctx.api, ctx.config.dataBranch).writeFiles(
      { 'CAPITO.md': md, 'map.json': JSON.stringify(map, null, 2) + '\n' },
      `Capito: comprehension map ${map.index}/100 (${map.darkCount} dark zones)`,
    );
    return true;
  } catch (e) {
    ctx.log.warning(`Could not write the map to branch ${ctx.config.dataBranch}: ${String(e)}`);
    return false;
  }
}

async function handleMap(ctx: Context): Promise<Outcome> {
  const { map, ledger, shallow, aiCommits } = await computeRepoMap(ctx);
  await publishMap(ctx, map, ledger, shallow, aiCommits);
  return { action: 'map-updated' };
}

async function replyWithMap(ctx: Context, number: number): Promise<Outcome> {
  const { map, ledger, shallow, aiCommits } = await computeRepoMap(ctx);
  const o = mapRenderOptions(ctx, ledger, shallow, aiCommits);
  await ctx.api.createComment(number, renderMapSummary(map, ctx.config.lang, o));
  return { action: 'replied', reason: 'map' };
}

// ---------------------------------------------------------------------------
// Weekly review
// ---------------------------------------------------------------------------

async function handleDigest(ctx: Context): Promise<Outcome> {
  const { api, config } = ctx;
  const { map, ledger, shallow, aiCommits } = await computeRepoMap(ctx);
  await publishMap(ctx, map, ledger, shallow, aiCommits);
  if (map.filesWithAi === 0) return skip('no AI-written code in the repository');

  // Files mentioned in open issues are about to be touched: review them first
  const boost = new Set<string>();
  let openIssues: Awaited<ReturnType<Api['listOpenIssues']>> = [];
  try {
    openIssues = await api.listOpenIssues();
    const isDigest = (i: (typeof openIssues)[number]) => i.labels.some((l) => (typeof l === 'string' ? l : l.name) === DIGEST_LABEL);
    for (const i of openIssues.filter((x) => !isDigest(x))) for (const e of findMentionedFiles(`${i.title}\n${i.body ?? ''}`, map.entries)) boost.add(e.file);
  } catch {
    /* optional */
  }
  const files = pickReviewFiles(map, config.digestFiles, boost);
  if (files.length === 0) {
    ctx.summary('🧠 **Capito**: every AI-written file is understood. No review needed this week. 🎉');
    return skip('nothing to review');
  }

  const keyMode: KeyMode = config.secret ? 'secret' : 'public';
  const result = await generateQuiz({
    cwd: ctx.cwd,
    testCommand: config.testCommand,
    lang: config.lang,
    key: keyFor(ctx, keyMode),
    keyMode,
    kind: 'digest',
    maxMutants: config.maxMutants,
    optionsCount: config.optionsCount,
    timeoutMs: config.timeoutMs,
    files,
    sha: ctx.sha,
    seed: `${ctx.repo}@${map.generatedAt.slice(0, 10)}`,
    log: ctx.log.info,
  });
  const lang = config.lang;
  const quizBody = result.quiz ? renderQuizBody(result.quiz, {}, linkCtx(ctx)) : null;
  const note =
    result.status === 'baseline-failed'
      ? messages.baselineFailed(lang, config.testCommand)
      : result.status === 'no-mutants'
        ? messages.noMutants(lang)
        : result.status === 'too-few'
          ? messages.tooFewResults(lang)
          : undefined;
  const { title, body } = renderDigestIssue(map, quizBody, lang, { ...mapRenderOptions(ctx, ledger, shallow, aiCommits), note });

  for (const old of openIssues.filter((i) => i.labels.some((l) => (typeof l === 'string' ? l : l.name) === DIGEST_LABEL))) {
    try {
      await api.closeIssue(old.number);
    } catch {
      /* not fatal */
    }
  }
  await api.ensureLabel(DIGEST_LABEL, '8B5CF6', lang === 'it' ? 'Ripasso settimanale di Capito' : 'Weekly Capito review');
  const issue = await api.createIssue(title, body, [DIGEST_LABEL]);
  if (result.quiz) ctx.output('quiz-id', result.quiz.id);
  ctx.summary(`🧠 **Capito**: weekly review opened as #${issue.number}.`);
  return { action: 'digest-created', issue: issue.number, quizId: result.quiz?.id };
}

// ---------------------------------------------------------------------------
// New issues: warn when a bug lands in a dark zone
// ---------------------------------------------------------------------------

async function handleIssue(ctx: Context): Promise<Outcome> {
  const { event, config, api } = ctx;
  if (event.action !== 'opened') return skip(`issues.${event.action}`);
  if (!config.alertOnIssues) return skip('alert-on-issues is off');
  const issue = event.issue;
  if (issue.user?.type === 'Bot') return skip('issue opened by a bot');
  if ((issue.labels ?? []).some((l: { name: string } | string) => (typeof l === 'string' ? l : l.name) === DIGEST_LABEL)) return skip('digest issue');
  const { map } = await computeRepoMap(ctx);
  const hits = findMentionedFiles(`${issue.title}\n${issue.body ?? ''}`, map.entries).filter((e) => e.dark);
  if (hits.length === 0) return skip('no dark zones mentioned');
  const tracked = listTrackedFiles(ctx.cwd);
  const related = new Map(hits.map((h) => [h.file, relatedTests(ctx.cwd, h.file, tracked, (p) => TEST_FILE_RE.test(p))]));
  await api.createComment(issue.number, renderAlert(hits.slice(0, 5), config.lang, related, { ...linkCtx(ctx), defaultBranch: defaultBranch(ctx) }));
  return { action: 'alerted', issue: issue.number };
}
