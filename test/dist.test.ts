import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeQuizMarker } from '../src/core/quiz.js';
import { makeDemoRepo } from './helpers.js';

/**
 * Runs the BUNDLED action (dist/index.js) exactly like the Actions runner does:
 * INPUT_* env vars, an event payload file, GITHUB_OUTPUT / GITHUB_STEP_SUMMARY files,
 * against a local HTTP server that mimics the GitHub REST API.
 */
const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));

let repo: ReturnType<typeof makeDemoRepo>;
let server: Server;
let port = 0;
const posted: Array<{ path: string; body: unknown }> = [];

beforeAll(async () => {
  repo = makeDemoRepo();
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== 'Bearer test-token') return send(401, { message: 'bad token' });
      if (req.method === 'GET' && url.pathname === '/repos/acme/shop/issues/7/comments') return send(200, []);
      if (req.method === 'GET' && url.pathname === '/repos/acme/shop/pulls/7/commits')
        return send(200, [{ sha: repo.headSha, commit: { message: 'feat\n\nCo-authored-by: Copilot <x@users.noreply.github.com>', author: { name: 'Ada' }, committer: { name: 'Ada' } }, author: { login: 'ada' } }]);
      if (req.method === 'POST' && url.pathname === '/repos/acme/shop/issues/7/comments') {
        posted.push({ path: url.pathname, body: JSON.parse(raw) });
        return send(201, { id: 1, body: JSON.parse(raw).body, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: new Date().toISOString() });
      }
      return send(404, { message: `unexpected ${req.method} ${url.pathname}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server?.close();
  repo?.cleanup();
});

describe('bundled action', () => {
  it('exists (run `npm run build` first)', () => {
    expect(existsSync(DIST)).toBe(true);
  });

  it('runs a pull_request event end to end through the real HTTP client', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'capito-dist-'));
    const eventPath = join(tmp, 'event.json');
    const outputPath = join(tmp, 'output.txt');
    const summaryPath = join(tmp, 'summary.md');
    writeFileSync(outputPath, '');
    writeFileSync(summaryPath, '');
    writeFileSync(
      eventPath,
      JSON.stringify({
        action: 'opened',
        repository: { default_branch: 'main' },
        pull_request: {
          number: 7,
          draft: false,
          head: { sha: repo.headSha, ref: 'feature', repo: { full_name: 'acme/shop' } },
          base: { sha: repo.baseSha, ref: 'main', repo: { full_name: 'acme/shop' } },
          user: { login: 'ada', type: 'User' },
        },
      }),
    );
    // Run asynchronously so this process can keep serving the fake API
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      import('node:child_process').then(({ spawn }) => {
        const child = spawn(process.execPath, [DIST], {
          cwd: repo.dir,
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: 'pull_request',
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: 'acme/shop',
            GITHUB_WORKSPACE: repo.dir,
            GITHUB_SHA: repo.headSha,
            GITHUB_API_URL: `http://127.0.0.1:${port}`,
            GITHUB_OUTPUT: outputPath,
            GITHUB_STEP_SUMMARY: summaryPath,
            'INPUT_GITHUB-TOKEN': 'test-token',
            'INPUT_TEST-COMMAND': 'npm test',
            INPUT_LANG: 'it',
            'INPUT_MAX-MUTANTS': '5',
          },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Capito: quiz-posted');
    expect(posted).toHaveLength(1);
    const body = (posted[0].body as { body: string }).body;
    expect(body).toContain('rilevato: `Co-authored-by: Copilot');
    expect(decodeQuizMarker(body)?.lang).toBe('it');
    const outputs = readFileSync(outputPath, 'utf8');
    expect(outputs).toMatch(/quiz-id<<capito_[0-9a-f]+\n[0-9a-f]{10}\n/);
    expect(outputs).toContain('quiz-posted');
    expect(readFileSync(summaryPath, 'utf8')).toContain('Capito');
    // sanity: the CLI bundle starts too
    expect(spawnSync(process.execPath, [DIST.replace('index.js', 'cli.js'), '--version'], { encoding: 'utf8' }).stdout.trim()).toBe('1.0.0');
  });
});
