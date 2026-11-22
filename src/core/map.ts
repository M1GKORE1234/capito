import type { Ledger } from './ledger.js';

/**
 * The comprehension map.
 *
 * For each source file we know:
 *   - how many of its lines were written by AI (from git blame + AI detection);
 *   - how many times a human proved they understood code in that file
 *     (correct answers in the ledger), each proof fading over time.
 *
 * score = min(100, 100 * credit / needed)
 *   credit = Σ 0.5 ^ (ageDays / halfLifeDays)   over correct answers on the file
 *   needed = ceil(aiLines / linesPerProof)       (default: one proof every 40 AI lines)
 *
 * A file is a "dark zone" when it has at least `minAiLines` AI lines
 * and its score is below `darkThreshold`.
 */

export interface FileStats {
  file: string;
  totalLines: number;
  aiLines: number;
}

export interface MapOptions {
  now?: Date;
  halfLifeDays?: number;
  linesPerProof?: number;
  minAiLines?: number;
  darkThreshold?: number;
}

export interface MapEntry extends FileStats {
  score: number;
  credit: number;
  needed: number;
  /** People whose (decayed) proofs on this file are still worth >= 0.5 */
  people: string[];
  /** Wrong answers on this file in the last half-life */
  misconceptions: number;
  lastProof?: string;
  dark: boolean;
}

export interface ComprehensionMap {
  generatedAt: string;
  /** Weighted average score over AI lines, 0–100 */
  index: number;
  aiLinesTotal: number;
  linesTotal: number;
  filesWithAi: number;
  darkCount: number;
  /** Lines in dark zones */
  darkLines: number;
  entries: MapEntry[];
  options: Required<Omit<MapOptions, 'now'>>;
}

export const DEFAULT_MAP_OPTIONS = {
  halfLifeDays: 90,
  linesPerProof: 40,
  minAiLines: 10,
  darkThreshold: 30,
};

export function computeMap(stats: FileStats[], ledger: Ledger, opts: MapOptions = {}): ComprehensionMap {
  const { now: nowDate, ...rest } = opts;
  const o = { ...DEFAULT_MAP_OPTIONS, ...stripUndefined(rest) };
  const now = (nowDate ?? new Date()).getTime();
  const dayMs = 86_400_000;

  // Aggregate proofs per file
  type Agg = { credit: number; byUser: Map<string, number>; wrong: number; last?: string };
  const perFile = new Map<string, Agg>();
  for (const ev of ledger.events) {
    const ageDays = Math.max(0, (now - Date.parse(ev.at)) / dayMs);
    const weight = Math.pow(0.5, ageDays / o.halfLifeDays);
    // One answer is worth at most ONE proof per file, scaled by how many options on that file were right
    const byFile = new Map<string, { right: number; total: number }>();
    for (const r of ev.results) {
      const t = byFile.get(r.file) ?? { right: 0, total: 0 };
      t.total++;
      if (r.correct) t.right++;
      byFile.set(r.file, t);
    }
    for (const [file, t] of byFile) {
      const f: Agg = perFile.get(file) ?? { credit: 0, byUser: new Map<string, number>(), wrong: 0 };
      const proof = weight * (t.right / t.total);
      if (proof > 0) {
        f.credit += proof;
        f.byUser.set(ev.user, (f.byUser.get(ev.user) ?? 0) + proof);
        if (!f.last || ev.at > f.last) f.last = ev.at;
      }
      if (ageDays <= o.halfLifeDays) f.wrong += t.total - t.right;
      perFile.set(file, f);
    }
  }

  const entries: MapEntry[] = stats
    .filter((s) => s.aiLines > 0)
    .map((s) => {
      const f = perFile.get(s.file);
      const needed = Math.max(1, Math.ceil(s.aiLines / o.linesPerProof));
      const credit = f?.credit ?? 0;
      const score = Math.min(100, Math.round((100 * credit) / needed));
      const people = f ? [...f.byUser.entries()].filter(([, w]) => w >= 0.5).sort((a, b) => b[1] - a[1]).map(([u]) => u) : [];
      return {
        ...s,
        score,
        credit: Math.round(credit * 100) / 100,
        needed,
        people,
        misconceptions: f?.wrong ?? 0,
        lastProof: f?.last,
        dark: s.aiLines >= o.minAiLines && score < o.darkThreshold,
      };
    })
    .sort((a, b) => Number(b.dark) - Number(a.dark) || b.aiLines * (100 - b.score) - a.aiLines * (100 - a.score) || a.file.localeCompare(b.file));

  const aiLinesTotal = entries.reduce((n, e) => n + e.aiLines, 0);
  const weighted = entries.reduce((n, e) => n + e.score * e.aiLines, 0);
  const dark = entries.filter((e) => e.dark);
  return {
    generatedAt: new Date(now).toISOString(),
    index: aiLinesTotal ? Math.round(weighted / aiLinesTotal) : 100,
    aiLinesTotal,
    linesTotal: stats.reduce((n, s) => n + s.totalLines, 0),
    filesWithAi: entries.length,
    darkCount: dark.length,
    darkLines: dark.reduce((n, e) => n + e.aiLines, 0),
    entries,
    options: o,
  };
}

/** Rank dark files for the weekly review. Files that are about to be touched get a boost. */
export function pickReviewFiles(map: ComprehensionMap, count: number, boost: Set<string> = new Set()): string[] {
  return map.entries
    .filter((e) => e.dark || e.score < 60)
    .map((e) => ({ e, rank: e.aiLines * (100 - e.score) * (boost.has(e.file) ? 3 : 1) * (e.misconceptions ? 1.5 : 1) }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, count)
    .map((x) => x.e.file);
}

export function heat(score: number): string {
  if (score >= 85) return '🟩';
  if (score >= 60) return '🟨';
  if (score >= 30) return '🟧';
  return '🟥';
}

export function bar(score: number, width = 10): string {
  const full = Math.round((score / 100) * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
