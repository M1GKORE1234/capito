import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Api, Comment, Issue, PullCommit, PullRequest } from '../src/github/api.js';
import { GitHubError } from '../src/github/api.js';

export const DEMO = fileURLToPath(new URL('../examples/demo-shop', import.meta.url));

export function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A git repo with a human base commit and an AI-written commit on top. Returns paths and SHAs. */
export function makeDemoRepo(): { dir: string; baseSha: string; headSha: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'capito-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.name', 'Ada']);
  sh(dir, ['config', 'user.email', 'ada@example.com']);
  sh(dir, ['config', 'commit.gpgsign', 'false']);
  execFileSync('sh', ['-c', 'echo "# demo" > README.md'], { cwd: dir });
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'Initial commit']);
  const baseSha = sh(dir, ['rev-parse', 'HEAD']).trim();
  cpSync(DEMO, dir, { recursive: true });
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'Add shopping cart\n\nCo-Authored-By: Claude <noreply@anthropic.com>']);
  const headSha = sh(dir, ['rev-parse', 'HEAD']).trim();
  return { dir, baseSha, headSha, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const BOT = { login: 'github-actions[bot]', type: 'Bot' };

/** In-memory GitHub, just enough for Capito. */
export class FakeApi implements Api {
  comments = new Map<number, Comment[]>();
  files = new Map<string, Map<string, { content: string; sha: string }>>();
  issues: Issue[] = [];
  labels = new Set<string>();
  permissions = new Map<string, string>();
  pulls = new Map<number, PullRequest>();
  commits = new Map<number, PullCommit[]>();
  reactions: Array<{ id: number; content: string }> = [];
  readOnly = false;
  private nextId = 1000;
  private shaCounter = 0;

  constructor(public repo = 'acme/shop') {}

  async listIssueComments(issue: number) {
    return [...(this.comments.get(issue) ?? [])];
  }
  async createComment(issue: number, body: string) {
    if (this.readOnly) throw new GitHubError(403, 'Resource not accessible by integration');
    const c: Comment = { id: this.nextId++, body, user: BOT, created_at: new Date().toISOString() };
    this.comments.set(issue, [...(this.comments.get(issue) ?? []), c]);
    return c;
  }
  /** Simulate a human writing a comment (not through the API under test). */
  human(issue: number, login: string, body: string): Comment {
    const c: Comment = { id: this.nextId++, body, user: { login, type: 'User' }, created_at: new Date().toISOString() };
    this.comments.set(issue, [...(this.comments.get(issue) ?? []), c]);
    return c;
  }
  lastComment(issue: number): string {
    const list = this.comments.get(issue) ?? [];
    return list[list.length - 1]?.body ?? '';
  }
  async updateComment(id: number, body: string) {
    for (const list of this.comments.values()) for (const c of list) if (c.id === id) c.body = body;
  }
  async addReaction(id: number, content: string) {
    this.reactions.push({ id, content });
  }
  async getPull(n: number) {
    const p = this.pulls.get(n);
    if (!p) throw new GitHubError(404, 'not found');
    return p;
  }
  async listPullCommits(n: number) {
    return this.commits.get(n) ?? [];
  }
  async getPermission(user: string) {
    return this.permissions.get(user) ?? 'read';
  }
  async getFile(path: string, ref: string) {
    return this.files.get(ref)?.get(path) ?? null;
  }
  async putFile(path: string, branch: string, content: string, _message: string, sha?: string) {
    const b = this.files.get(branch);
    if (!b) throw new GitHubError(404, 'branch not found');
    const existing = b.get(path);
    if (existing && existing.sha !== sha) throw new GitHubError(409, 'sha mismatch');
    if (!existing && sha) throw new GitHubError(422, 'sha given for new file');
    b.set(path, { content, sha: `sha${++this.shaCounter}` });
  }
  async branchExists(branch: string) {
    return this.files.has(branch);
  }
  async createOrphanBranch(branch: string, files: Record<string, string>) {
    if (this.files.has(branch)) throw new GitHubError(422, 'exists');
    this.files.set(branch, new Map(Object.entries(files).map(([p, c]) => [p, { content: c, sha: `sha${++this.shaCounter}` }])));
  }
  async createIssue(title: string, body: string, labels: string[]) {
    const issue: Issue = { number: this.nextId++, title, body, state: 'open', user: BOT, labels: labels.map((name) => ({ name })) };
    this.issues.push(issue);
    return issue;
  }
  async closeIssue(n: number) {
    const i = this.issues.find((x) => x.number === n);
    if (i) i.state = 'closed';
  }
  async listOpenIssues(label?: string) {
    return this.issues.filter((i) => i.state === 'open' && (!label || i.labels.some((l) => (typeof l === 'string' ? l : l.name) === label)));
  }
  async ensureLabel(name: string) {
    this.labels.add(name);
  }
}
