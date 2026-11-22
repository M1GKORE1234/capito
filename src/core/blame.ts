import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiDetector } from './ai-detect.js';
import { git, listTrackedFiles, tryGit } from './git.js';
import type { FileStats } from './map.js';

export interface BlameOptions {
  match: (path: string) => boolean;
  detector: AiDetector;
  /** Count every line as AI-written (for repos built entirely with AI tools that leave no trace). */
  treatAllAsAi?: boolean;
  maxFiles?: number;
  log?: (msg: string) => void;
}

export interface BlameReport {
  stats: FileStats[];
  aiCommits: number;
  totalCommits: number;
  shallow: boolean;
  skippedFiles: number;
}

/** SHAs of all commits that look AI-written. */
export function findAiCommits(cwd: string, detector: AiDetector): { ai: Set<string>; total: number } {
  const raw = tryGit(['log', '--no-color', '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%B%x1e'], cwd) ?? '';
  const ai = new Set<string>();
  let total = 0;
  for (const rec of raw.split('\x1e')) {
    const [sha, an, ae, cn, ...msg] = rec.replace(/^\n+/, '').split('\x1f');
    if (!sha || sha.length < 40) continue;
    total++;
    if (detector.isAiCommit({ sha, message: msg.join('\x1f'), authorName: an, authorEmail: ae, committerName: cn })) ai.add(sha);
  }
  return { ai, total };
}

/** Count non-blank lines per file, and how many of them come from AI commits. */
export function aiLineStats(cwd: string, opts: BlameOptions): BlameReport {
  const shallow = (tryGit(['rev-parse', '--is-shallow-repository'], cwd) ?? '').trim() === 'true';
  const { ai, total } = findAiCommits(cwd, opts.detector);
  const files = listTrackedFiles(cwd).filter(opts.match);
  const maxFiles = opts.maxFiles ?? 2000;
  const stats: FileStats[] = [];
  let skipped = 0;
  for (const file of files.slice(0, maxFiles)) {
    if (opts.treatAllAsAi) {
      let text = '';
      try {
        text = readFileSync(join(cwd, file), 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n').filter((l) => l.trim() !== '').length;
      stats.push({ file, totalLines: lines, aiLines: lines });
      continue;
    }
    if (ai.size === 0) {
      // Still report sizes so the map can say "no AI code detected"
      let text = '';
      try {
        text = readFileSync(join(cwd, file), 'utf8');
      } catch {
        continue;
      }
      stats.push({ file, totalLines: text.split('\n').filter((l) => l.trim() !== '').length, aiLines: 0 });
      continue;
    }
    let out: string;
    try {
      out = git(['blame', '--porcelain', 'HEAD', '--', file], cwd);
    } catch {
      skipped++;
      continue;
    }
    let currentSha = '';
    let totalLines = 0;
    let aiLines = 0;
    for (const line of out.split('\n')) {
      if (line.startsWith('\t')) {
        if (line.slice(1).trim() === '') continue;
        totalLines++;
        if (ai.has(currentSha)) aiLines++;
      } else {
        const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
        if (m) currentSha = m[1];
      }
    }
    stats.push({ file, totalLines, aiLines });
  }
  skipped += Math.max(0, files.length - maxFiles);
  return { stats, aiCommits: ai.size, totalCommits: total, shallow, skippedFiles: skipped };
}
