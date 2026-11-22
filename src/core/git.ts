import { execFileSync } from 'node:child_process';

export function git(args: string[], cwd: string, maxBuffer = 256 * 1024 * 1024): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Parse `git diff --unified=0` output into the set of added/changed lines
 * (new-file line numbers) for each file.
 */
export function parseUnifiedDiff(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target === '/dev/null') {
        current = null;
        continue;
      }
      const path = target.replace(/^b\//, '').replace(/^"(.*)"$/, '$1');
      current = out.get(path) ?? new Set<number>();
      out.set(path, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i++) current.add(start + i);
    }
  }
  for (const [file, lines] of out) if (lines.size === 0) out.delete(file);
  return out;
}

/** Changed lines between `base` and the working tree HEAD. */
export function changedLines(cwd: string, base: string): Map<string, Set<number>> {
  const diff = git(['diff', '--relative', '--unified=0', '--no-color', '--no-ext-diff', '--diff-filter=AMR', base, 'HEAD'], cwd);
  return parseUnifiedDiff(diff);
}

/** Changed lines between `base` and the working tree (includes uncommitted edits). */
export function changedLinesWorktree(cwd: string, base: string): Map<string, Set<number>> {
  const diff = git(['diff', '--relative', '--unified=0', '--no-color', '--no-ext-diff', '--diff-filter=AMR', base], cwd);
  return parseUnifiedDiff(diff);
}

/**
 * Pick the right diff base for a pull request checkout.
 * actions/checkout checks out the merge commit `refs/pull/N/merge`;
 * its first parent is the base branch tip, so HEAD^1..HEAD is exactly the PR.
 */
export function prDiffBase(cwd: string, baseSha?: string): string {
  const parents = (tryGit(['rev-list', '--parents', '-n', '1', 'HEAD'], cwd) ?? '').trim().split(/\s+/);
  if (parents.length === 3) return 'HEAD^1';
  if (baseSha) {
    const mb = tryGit(['merge-base', baseSha, 'HEAD'], cwd);
    if (mb) return mb.trim();
    return baseSha;
  }
  return 'HEAD^1';
}

export function listTrackedFiles(cwd: string): string[] {
  return git(['ls-files', '-z'], cwd)
    .split('\0')
    .filter(Boolean);
}
