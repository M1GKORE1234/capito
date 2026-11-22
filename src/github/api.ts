/**
 * Minimal GitHub REST client built on fetch (Node >= 20).
 * Only the endpoints Capito uses. Works with GitHub Enterprise via GITHUB_API_URL.
 */

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Comment {
  id: number;
  body: string;
  user: { login: string; type: string } | null;
  created_at: string;
  html_url?: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string; type: string } | null;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
  html_url?: string;
}

export interface PullRequest {
  number: number;
  draft?: boolean;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } };
  user: { login: string; type: string } | null;
}

export interface PullCommit {
  sha: string;
  commit: { message: string; author: { name?: string; email?: string } | null; committer: { name?: string } | null };
  author: { login: string } | null;
}

/** The subset of the API used by Capito. Implemented by GitHubApi and by the in-memory fake in tests. */
export interface Api {
  repo: string;
  listIssueComments(issue: number): Promise<Comment[]>;
  createComment(issue: number, body: string): Promise<Comment>;
  updateComment(id: number, body: string): Promise<void>;
  addReaction(commentId: number, content: '+1' | 'eyes' | 'rocket' | 'confused'): Promise<void>;
  getPull(n: number): Promise<PullRequest>;
  listPullCommits(n: number): Promise<PullCommit[]>;
  getPermission(user: string): Promise<string>;
  getFile(path: string, ref: string): Promise<{ content: string; sha: string } | null>;
  putFile(path: string, branch: string, content: string, message: string, sha?: string): Promise<void>;
  branchExists(branch: string): Promise<boolean>;
  createOrphanBranch(branch: string, files: Record<string, string>, message: string): Promise<void>;
  createIssue(title: string, body: string, labels: string[]): Promise<Issue>;
  closeIssue(n: number): Promise<void>;
  listOpenIssues(label?: string): Promise<Issue[]>;
  ensureLabel(name: string, color: string, description: string): Promise<void>;
}

export class GitHubApi implements Api {
  private base: string;
  constructor(
    private token: string,
    public repo: string,
    apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com',
  ) {
    this.base = apiUrl.replace(/\/$/, '');
  }

  async request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'capito-action',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if ((res.status >= 500 || res.status === 429) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return this.request<T>(method, path, body, attempt + 1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(res.status, `${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async paginate<T>(path: string, max = 1000): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; out.length < max; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const items = await this.request<T[]>('GET', `${path}${sep}per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  private r(path: string): string {
    return `/repos/${this.repo}${path}`;
  }

  listIssueComments(issue: number) {
    return this.paginate<Comment>(this.r(`/issues/${issue}/comments`));
  }
  createComment(issue: number, body: string) {
    return this.request<Comment>('POST', this.r(`/issues/${issue}/comments`), { body });
  }
  async updateComment(id: number, body: string) {
    await this.request('PATCH', this.r(`/issues/comments/${id}`), { body });
  }
  async addReaction(commentId: number, content: '+1' | 'eyes' | 'rocket' | 'confused') {
    try {
      await this.request('POST', this.r(`/issues/comments/${commentId}/reactions`), { content });
    } catch {
      /* reactions are cosmetic */
    }
  }
  getPull(n: number) {
    return this.request<PullRequest>('GET', this.r(`/pulls/${n}`));
  }
  listPullCommits(n: number) {
    return this.paginate<PullCommit>(this.r(`/pulls/${n}/commits`), 250);
  }
  async getPermission(user: string) {
    try {
      const res = await this.request<{ permission: string }>('GET', this.r(`/collaborators/${encodeURIComponent(user)}/permission`));
      return res.permission;
    } catch {
      return 'none';
    }
  }
  async getFile(path: string, ref: string) {
    try {
      const res = await this.request<{ content: string; encoding: string; sha: string; size: number }>(
        'GET',
        this.r(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`),
      );
      if (res.encoding !== 'base64' || (!res.content && res.size > 0)) {
        // Files over 1 MB: the contents API omits the body, the blobs API does not
        const blob = await this.request<{ content: string }>('GET', this.r(`/git/blobs/${res.sha}`));
        return { content: Buffer.from(blob.content, 'base64').toString('utf8'), sha: res.sha };
      }
      return { content: Buffer.from(res.content, 'base64').toString('utf8'), sha: res.sha };
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }
  async putFile(path: string, branch: string, content: string, message: string, sha?: string) {
    await this.request('PUT', this.r(`/contents/${path.split('/').map(encodeURIComponent).join('/')}`), {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    });
  }
  async branchExists(branch: string) {
    try {
      await this.request('GET', this.r(`/git/ref/heads/${encodeURIComponent(branch)}`));
      return true;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return false;
      throw e;
    }
  }
  async createOrphanBranch(branch: string, files: Record<string, string>, message: string) {
    const tree = await this.request<{ sha: string }>('POST', this.r('/git/trees'), {
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
    });
    const commit = await this.request<{ sha: string }>('POST', this.r('/git/commits'), { message, tree: tree.sha, parents: [] });
    await this.request('POST', this.r('/git/refs'), { ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  createIssue(title: string, body: string, labels: string[]) {
    return this.request<Issue>('POST', this.r('/issues'), { title, body, labels });
  }
  async closeIssue(n: number) {
    await this.request('PATCH', this.r(`/issues/${n}`), { state: 'closed', state_reason: 'completed' });
  }
  async listOpenIssues(label?: string) {
    const q = label ? `?state=open&labels=${encodeURIComponent(label)}` : '?state=open';
    const items = await this.paginate<Issue>(this.r(`/issues${q}`), 300);
    return items.filter((i) => !i.pull_request);
  }
  async ensureLabel(name: string, color: string, description: string) {
    try {
      await this.request('POST', this.r('/labels'), { name, color, description });
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422) return; // already exists
      throw e;
    }
  }
}
