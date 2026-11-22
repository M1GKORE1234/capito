import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from '../src/core/glob.js';
import { parseLedger } from '../src/core/ledger.js';
import { decodeQuizMarker, openAnswers, type Quiz } from '../src/core/quiz.js';
import { deriveKey } from '../src/core/seal.js';
import { run, type Config, type Context } from '../src/github/run.js';
import { FakeApi, makeDemoRepo, sh } from './helpers.js';

const REPO = 'acme/shop';

function config(overrides: Partial<Config> = {}): Config {
  return {
    testCommand: 'npm test',
    lang: 'en',
    maxMutants: 6,
    optionsCount: 3,
    aiOnly: true,
    aiMarkers: [],
    include: DEFAULT_INCLUDE,
    exclude: DEFAULT_EXCLUDE,
    halfLifeDays: 90,
    linesPerProof: 40,
    minAiLines: 10,
    darkThreshold: 30,
    dataBranch: 'capito-data',
    anonymous: false,
    digestFiles: 2,
    treatAllAsAi: false,
    alertOnIssues: true,
    includeDrafts: false,
    mode: 'auto',
    ...overrides,
  };
}

let repo: ReturnType<typeof makeDemoRepo>;
const summaries: string[] = [];
const outputs: Record<string, string | number> = {};

function ctx(api: FakeApi, eventName: string, event: unknown, cfg: Partial<Config> = {}): Context {
  return {
    eventName,
    event,
    repo: REPO,
    cwd: repo.dir,
    serverUrl: 'https://github.com',
    sha: repo.headSha,
    api,
    config: config(cfg),
    log: { info: () => {}, warning: () => {} },
    summary: (m) => summaries.push(m),
    output: (n, v) => (outputs[n] = v),
  };
}

function prEvent(action = 'opened', extra: Record<string, unknown> = {}) {
  return {
    action,
    repository: { default_branch: 'main' },
    pull_request: {
      number: 7,
      draft: false,
      head: { sha: repo.headSha, ref: 'feature', repo: { full_name: REPO } },
      base: { sha: repo.baseSha, ref: 'main', repo: { full_name: REPO } },
      user: { login: 'ada', type: 'User' },
      ...extra,
    },
  };
}

function commentEvent(api: FakeApi, issue: number, login: string, body: string, isPr = true) {
  const c = api.human(issue, login, body);
  return {
    action: 'created',
    repository: { default_branch: 'main' },
    issue: { number: issue, body: null, user: { login: 'ada', type: 'User' }, labels: [], ...(isPr ? { pull_request: {} } : {}) },
    comment: c,
  };
}

function aiCommits(api: FakeApi) {
  api.commits.set(7, [
    {
      sha: repo.headSha,
      commit: { message: 'Add shopping cart\n\nCo-Authored-By: Claude <noreply@anthropic.com>', author: { name: 'Ada' }, committer: { name: 'Ada' } },
      author: { login: 'ada' },
    },
  ]);
  api.pulls.set(7, prEvent().pull_request as never);
}

function quizFrom(body: string): Quiz {
  const q = decodeQuizMarker(body);
  if (!q) throw new Error('no quiz in: ' + body.slice(0, 200));
  return q;
}

function rightLetters(q: Quiz, secret?: string): string {
  const a = openAnswers(q, deriveKey(q.keyMode, REPO, secret))!;
  return a.caught.length ? a.caught.join(' ') : 'none';
}

function wrongLetters(q: Quiz, secret?: string): string {
  const a = openAnswers(q, deriveKey(q.keyMode, REPO, secret))!;
  const inverse = q.options.map((o) => o.letter).filter((l) => !a.caught.includes(l));
  return inverse.length ? inverse.join(' ') : 'none';
}

beforeAll(() => {
  repo = makeDemoRepo();
});
afterAll(() => repo.cleanup());

describe('pull request flow', () => {
  it('asks a question on an AI-written PR, grades answers once per person, and records them', async () => {
    const api = new FakeApi(REPO);
    aiCommits(api);

    const asked = await run(ctx(api, 'pull_request', prEvent()));
    expect(asked.action).toBe('quiz-posted');
    const quizBody = api.lastComment(7);
    expect(quizBody).toContain('Which of these changes make your tests fail?');
    expect(quizBody).toContain('detected: `Co-Authored-By: Claude');
    const quiz = quizFrom(quizBody);
    expect(quiz.keyMode).toBe('public');
    expect(quiz.options.every((o) => o.file === 'src/cart.js')).toBe(true);
    // the working tree is restored after mutation testing
    expect(sh(repo.dir, ['status', '--porcelain'])).toBe('');

    // pushing again does not spam a second quiz
    expect((await run(ctx(api, 'pull_request', prEvent('synchronize')))).action).toBe('skipped');

    // Ada answers correctly
    const ok = await run(ctx(api, 'issue_comment', commentEvent(api, 7, 'ada', `/capito ${rightLetters(quiz)}`)));
    expect(ok.action).toBe('graded');
    expect(api.lastComment(7)).toContain(`@ada **${quiz.options.length}/${quiz.options.length} — Capito!**`);
    expect(api.reactions.at(-1)?.content).toBe('rocket');

    // Ada cannot answer twice
    const again = await run(ctx(api, 'issue_comment', commentEvent(api, 7, 'ada', '/capito A')));
    expect(again.action).toBe('duplicate');
    expect(api.lastComment(7)).toContain('already answered');

    // Bob gets everything wrong
    const bob = await run(ctx(api, 'issue_comment', commentEvent(api, 7, 'bob', `/capito ${wrongLetters(quiz)}`)));
    expect(bob.action).toBe('graded');
    expect(api.lastComment(7)).toContain('@bob **0/');
    expect(api.lastComment(7)).toContain('Worth a second look');

    const ledger = parseLedger(api.files.get('capito-data')!.get('ledger.json')!.content);
    expect(ledger.events.map((e) => [e.user, e.correct])).toEqual([
      ['ada', quiz.options.length],
      ['bob', 0],
    ]);
    expect(api.files.get('capito-data')!.has('README.md')).toBe(true);
  });

  it('skips pull requests without AI-written commits and drafts', async () => {
    const api = new FakeApi(REPO);
    api.commits.set(7, [{ sha: repo.headSha, commit: { message: 'Add cart', author: { name: 'Ada' }, committer: { name: 'Ada' } }, author: { login: 'ada' } }]);
    expect((await run(ctx(api, 'pull_request', prEvent()))).reason).toBe('no AI-written commits');
    aiCommits(api);
    expect((await run(ctx(api, 'pull_request', prEvent('opened', { draft: true })))).action).toBe('skipped');
    expect(api.comments.size).toBe(0);
  });

  it('puts the quiz in the job summary when the token is read-only (forks)', async () => {
    const api = new FakeApi(REPO);
    aiCommits(api);
    api.readOnly = true;
    const res = await run(ctx(api, 'pull_request', prEvent()));
    expect(res.action).toBe('quiz-in-summary');
    expect(summaries.at(-1)).toContain('capito:quiz:v1');
  });

  it('uses the repository secret when configured, and refuses to grade without it', async () => {
    const api = new FakeApi(REPO);
    aiCommits(api);
    await run(ctx(api, 'pull_request', prEvent(), { secret: 'hunter2', lang: 'it' }));
    const quiz = quizFrom(api.lastComment(7));
    expect(quiz.keyMode).toBe('secret');
    expect(api.lastComment(7)).toContain('Quali di queste modifiche fanno fallire i test?');
    // public key cannot open it
    expect(openAnswers(quiz, deriveKey('public', REPO))).toBeNull();

    const missing = await run(ctx(api, 'issue_comment', commentEvent(api, 7, 'ada', '/capito A')));
    expect(missing.reason).toBe('missing secret');

    const graded = await run(ctx(api, 'issue_comment', commentEvent(api, 7, 'ada', `/capito ${rightLetters(quiz, 'hunter2')}`), { secret: 'hunter2', lang: 'it' }));
    expect(graded.action).toBe('graded');
    expect(api.lastComment(7)).toContain('Capito!');
  });

  it('trusts secret-sealed quizzes from any author (personal access tokens), public ones only from bots', async () => {
    const api = new FakeApi(REPO);
    aiCommits(api);
    await run(ctx(api, 'pull_request', prEvent(), { secret: 's' }));
    const quiz = quizFrom(api.lastComment(7));
    // Re-post the same quiz as if a human account (PAT) had written it
    const list = api.comments.get(7)!;
    list[0].user = { login: 'ada-pat', type: 'User' };
    const graded = await run(ctx(api, 'issue_comment', commentEvent(api, 7, 'bob', `/capito ${rightLetters(quiz, 's')}`), { secret: 's' }));
    expect(graded.action).toBe('graded');

    // A public-key quiz pasted by a human is ignored
    const api2 = new FakeApi(REPO);
    aiCommits(api2);
    await run(ctx(api2, 'pull_request', prEvent()));
    api2.comments.get(7)![0].user = { login: 'mallory', type: 'User' };
    const res = await run(ctx(api2, 'issue_comment', commentEvent(api2, 7, 'bob', '/capito A')));
    expect(res.reason).toBe('no quiz');
  });

  it('refuses pull_request_target', async () => {
    const api = new FakeApi(REPO);
    expect((await run(ctx(api, 'pull_request_target', prEvent()))).action).toBe('skipped');
  });
});

describe('commands', () => {
  it('answers help, invalid input and missing quizzes', async () => {
    const api = new FakeApi(REPO);
    expect((await run(ctx(api, 'issue_comment', commentEvent(api, 3, 'ada', '/capito')))).reason).toBe('help');
    expect(api.lastComment(3)).toContain('Capito commands');
    expect((await run(ctx(api, 'issue_comment', commentEvent(api, 3, 'ada', '/capito perhaps')))).reason).toBe('invalid');
    expect((await run(ctx(api, 'issue_comment', commentEvent(api, 3, 'ada', '/capito B')))).reason).toBe('no quiz');
    expect((await run(ctx(api, 'issue_comment', commentEvent(api, 3, 'ada', 'just a normal comment')))).action).toBe('skipped');
  });

  it('runs on-demand quizzes only for people with write access', async () => {
    const api = new FakeApi(REPO);
    const denied = await run(ctx(api, 'issue_comment', commentEvent(api, 4, 'mallory', '/capito quiz src/cart.js', false)));
    expect(denied.reason).toBe('not allowed');

    api.permissions.set('ada', 'write');
    const res = await run(ctx(api, 'issue_comment', commentEvent(api, 4, 'ada', '/capito quiz src/cart.js', false)));
    expect(res.action).toBe('quiz-posted');
    const quiz = quizFrom(api.lastComment(4));
    expect(quiz.kind).toBe('on-demand');
    expect(api.lastComment(4)).toContain('Quiz on `src/cart.js`');

    const graded = await run(ctx(api, 'issue_comment', commentEvent(api, 4, 'ada', `/capito ${rightLetters(quiz)}`, false)));
    expect(graded.action).toBe('graded');
  });

  it('replies with the comprehension map', async () => {
    const api = new FakeApi(REPO);
    const res = await run(ctx(api, 'issue_comment', commentEvent(api, 5, 'ada', '/capito map', false)));
    expect(res.reason).toBe('map');
    expect(api.lastComment(5)).toContain('Comprehension index');
    expect(api.lastComment(5)).toContain('src/cart.js');
  });
});

describe('map, weekly review and alerts', () => {
  it('opens a weekly review issue with a quiz on the darkest file, and grades answers on it', async () => {
    const api = new FakeApi(REPO);
    const res = await run(ctx(api, 'schedule', { repository: { default_branch: 'main' } }, { lang: 'it' }));
    expect(res.action).toBe('digest-created');
    const issue = api.issues[0];
    expect(issue.title).toContain('ripasso della settimana');
    expect(issue.labels).toEqual([{ name: 'capito-digest' }]);
    expect(api.files.get('capito-data')!.get('CAPITO.md')!.content).toContain('Mappa della comprensione');
    expect(api.files.get('capito-data')!.get('CAPITO.md')!.content).toContain('Zone buie');
    expect(typeof outputs['comprehension-index']).toBe('number');

    // Next week, if nobody answered, the old review is closed and a new one opened
    await run(ctx(api, 'schedule', { repository: { default_branch: 'main' } }, { lang: 'it' }));
    expect(api.issues.filter((i) => i.state === 'open')).toHaveLength(1);
    expect(api.issues[0].state).toBe('closed');
    const latest = api.issues[1];

    // The quiz lives in the issue body: answering in the issue works
    const quiz = quizFrom(latest.body!);
    const c = api.human(latest.number, 'ada', `/capito ${rightLetters(quiz)}`);
    const graded = await run(
      ctx(api, 'issue_comment', { action: 'created', repository: { default_branch: 'main' }, issue: { number: latest.number, body: latest.body, user: latest.user, labels: latest.labels }, comment: c }, { lang: 'it' }),
    );
    expect(graded.action).toBe('graded');

    // Once the only AI file is understood, there is nothing left to review
    const after = await run(ctx(api, 'schedule', { repository: { default_branch: 'main' } }, { lang: 'it' }));
    expect(after.reason).toBe('nothing to review');
    expect(api.files.get('capito-data')!.get('CAPITO.md')!.content).toContain('@ada');
  });

  it('warns when a new issue mentions a dark zone, and stays quiet otherwise', async () => {
    const api = new FakeApi(REPO);
    const event = (body: string) => ({
      action: 'opened',
      repository: { default_branch: 'main' },
      issue: { number: 42, title: 'Checkout broken', body, user: { login: 'carol', type: 'User' }, labels: [] },
    });
    const res = await run(ctx(api, 'issues', event('TypeError at src/cart.js:23 when the user is banned')));
    expect(res.action).toBe('alerted');
    expect(api.lastComment(42)).toContain('Dark zone ahead');
    expect(api.lastComment(42)).toContain('test/cart.test.js');
    expect(api.lastComment(42)).toContain('/capito quiz src/cart.js');

    expect((await run(ctx(api, 'issues', event('The logo is blurry')))).reason).toBe('no dark zones mentioned');
    expect((await run(ctx(api, 'issues', event('src/cart.js again'), { alertOnIssues: false }))).action).toBe('skipped');
  });

  it('updates the map on pushes to the default branch only', async () => {
    const api = new FakeApi(REPO);
    expect((await run(ctx(api, 'push', { ref: 'refs/heads/feature', repository: { default_branch: 'main' } }))).action).toBe('skipped');
    expect((await run(ctx(api, 'push', { ref: 'refs/heads/main', repository: { default_branch: 'main' } }))).action).toBe('map-updated');
    expect(JSON.parse(api.files.get('capito-data')!.get('map.json')!.content).filesWithAi).toBe(1);
  });
});
