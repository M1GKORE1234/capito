import { parse, type ParserPlugin } from '@babel/parser';

/**
 * Mutation engine for JavaScript / TypeScript.
 *
 * A "mutant" is a copy of a source file with ONE small, realistic change
 * (a flipped comparison, a swapped `&&`, an off-by-one number...).
 * Capito runs the project's own tests against each mutant: if the tests fail,
 * the change is "caught"; if they still pass, the change "survives".
 * That observed result is the ground truth for the questions we ask humans.
 */

export type OperatorId =
  | 'cmp-stricter'
  | 'cmp-looser'
  | 'eq-flip'
  | 'and-to-or'
  | 'or-to-and'
  | 'arith'
  | 'assign-arith'
  | 'bool-flip'
  | 'drop-not'
  | 'num-plus-one'
  | 'update-flip';

export interface Mutant {
  /** Stable id inside one run, e.g. `src/cart.ts:12:7:>=:>` */
  id: string;
  file: string;
  /** 1-based line and column of the mutated token */
  line: number;
  column: number;
  /** Offsets in the original source */
  start: number;
  end: number;
  original: string;
  replacement: string;
  operator: OperatorId;
  /** The full original line and the same line after the mutation (for display) */
  originalLine: string;
  mutatedLine: string;
}

const ARITH_SWAP: Record<string, string> = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '*' };
const ASSIGN_SWAP: Record<string, string> = { '+=': '-=', '-=': '+=', '*=': '/=', '/=': '*=' };
const CMP_SWAP: Record<string, [string, OperatorId]> = {
  '>=': ['>', 'cmp-stricter'],
  '<=': ['<', 'cmp-stricter'],
  '>': ['>=', 'cmp-looser'],
  '<': ['<=', 'cmp-looser'],
};
const EQ_SWAP: Record<string, string> = { '===': '!==', '!==': '===', '==': '!=', '!=': '==' };

const SKIP_KEYS = new Set([
  'loc',
  'start',
  'end',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'comments',
  'tokens',
  'range',
]);

export function pluginsFor(file: string): ParserPlugin[] {
  const ext = file.toLowerCase().split('.').pop() ?? '';
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return ['typescript'];
  if (ext === 'tsx') return ['typescript', 'jsx'];
  return ['jsx'];
}

/** Replace comments with spaces (same length) so offsets stay valid. */
function maskComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length)).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function position(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

interface AnyNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

function isNode(v: unknown): v is AnyNode {
  return typeof v === 'object' && v !== null && typeof (v as AnyNode).type === 'string' && typeof (v as AnyNode).start === 'number';
}

function walk(node: AnyNode, parent: AnyNode | null, visit: (n: AnyNode, p: AnyNode | null) => boolean | void): void {
  // `visit` returns false to skip a subtree (e.g. type annotations)
  if (visit(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, node, visit);
    } else if (isNode(value)) {
      walk(value, node, visit);
    }
  }
}

export interface FindOptions {
  /** If set, only mutate tokens on these 1-based lines. */
  lines?: Set<number>;
}

/**
 * Find every mutation Capito knows how to make in `source`.
 * Returns an empty list (never throws) if the file cannot be parsed.
 */
export function findMutants(file: string, source: string, options: FindOptions = {}): Mutant[] {
  let ast: { program: AnyNode };
  try {
    ast = parse(source, {
      sourceType: 'unambiguous',
      plugins: pluginsFor(file),
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    }) as unknown as { program: AnyNode };
  } catch {
    return [];
  }

  const starts = lineStarts(source);
  const masked = maskComments(source);
  const out: Mutant[] = [];
  const seen = new Set<string>();

  const add = (start: number, end: number, replacement: string, operator: OperatorId) => {
    const original = source.slice(start, end);
    if (original === replacement) return;
    const { line, column } = position(starts, start);
    if (options.lines && !options.lines.has(line)) return;
    const id = `${file}:${line}:${column}:${original}:${replacement}`;
    if (seen.has(id)) return;
    seen.add(id);
    const lineStart = starts[line - 1];
    const lineEndIdx = source.indexOf('\n', lineStart);
    const lineEnd = lineEndIdx === -1 ? source.length : lineEndIdx;
    const originalLine = source.slice(lineStart, lineEnd).replace(/\r$/, '');
    const mutatedLine = (source.slice(lineStart, start) + replacement + source.slice(end, lineEnd)).replace(/\r$/, '');
    out.push({ id, file, line, column, start, end, original, replacement, operator, originalLine, mutatedLine });
  };

  /** Locate an operator token between two child nodes. */
  const findOp = (from: number, to: number, op: string): number => {
    const idx = masked.slice(from, to).indexOf(op);
    return idx === -1 ? -1 : from + idx;
  };

  walk(ast.program, null, (node, parent) => {
    // Never mutate type-level code, declarations-only or enums
    if (/^TS.*(Type|Keyword|Annotation|Declaration|Instantiation|Signature)$/.test(node.type)) {
      return false;
    }
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') return false;

    switch (node.type) {
      case 'BinaryExpression': {
        const op = node.operator as string;
        const left = node.left as AnyNode;
        const right = node.right as AnyNode;
        let replacement: string | undefined;
        let operator: OperatorId | undefined;
        if (CMP_SWAP[op]) [replacement, operator] = CMP_SWAP[op];
        else if (EQ_SWAP[op]) [replacement, operator] = [EQ_SWAP[op], 'eq-flip'];
        else if (ARITH_SWAP[op]) {
          // `'a' + b` is string concatenation: mutating it is noise, skip it
          const isString = (n: AnyNode) => n.type === 'StringLiteral' || n.type === 'TemplateLiteral';
          if (op === '+' && (isString(left) || isString(right))) break;
          [replacement, operator] = [ARITH_SWAP[op], 'arith'];
        }
        if (!replacement || !operator) break;
        const at = findOp(left.end, right.start, op);
        if (at >= 0) add(at, at + op.length, replacement, operator);
        break;
      }
      case 'LogicalExpression': {
        const op = node.operator as string;
        if (op !== '&&' && op !== '||') break;
        const at = findOp((node.left as AnyNode).end, (node.right as AnyNode).start, op);
        if (at >= 0) add(at, at + 2, op === '&&' ? '||' : '&&', op === '&&' ? 'and-to-or' : 'or-to-and');
        break;
      }
      case 'AssignmentExpression': {
        const op = node.operator as string;
        if (!ASSIGN_SWAP[op]) break;
        const at = findOp((node.left as AnyNode).end, (node.right as AnyNode).start, op);
        if (at >= 0) add(at, at + op.length, ASSIGN_SWAP[op], 'assign-arith');
        break;
      }
      case 'UpdateExpression': {
        const op = node.operator as string;
        const at = node.prefix ? node.start : node.end - 2;
        if (source.slice(at, at + 2) === op) add(at, at + 2, op === '++' ? '--' : '++', 'update-flip');
        break;
      }
      case 'UnaryExpression': {
        if (node.operator !== '!') break;
        const arg = node.argument as AnyNode;
        // `!!x` is a boolean cast, not a real negation
        if (arg.type === 'UnaryExpression' && arg.operator === '!') break;
        if (parent && parent.type === 'UnaryExpression' && parent.operator === '!') break;
        if (source[node.start] === '!') add(node.start, node.start + 1, '', 'drop-not');
        break;
      }
      case 'BooleanLiteral': {
        add(node.start, node.end, node.value ? 'false' : 'true', 'bool-flip');
        break;
      }
      case 'NumericLiteral': {
        if (parent && (parent.type === 'ObjectProperty' || parent.type === 'ClassProperty' || parent.type === 'ObjectMethod') && parent.key === node) break;
        const raw = source.slice(node.start, node.end);
        if (!/^\d+$/.test(raw)) break; // only plain decimal integers
        const n = Number(raw);
        if (!Number.isSafeInteger(n)) break;
        add(node.start, node.end, String(n + 1), 'num-plus-one');
        break;
      }
    }
    return true;
  });

  return out.sort((a, b) => a.start - b.start);
}

/** Apply a mutant to the original source. */
export function applyMutant(source: string, m: Mutant): string {
  return source.slice(0, m.start) + m.replacement + source.slice(m.end);
}

/**
 * Pick a varied, deterministic subset of mutants:
 * spread across lines and operator kinds, at most `max`.
 */
export function selectMutants(all: Mutant[], max: number, seed = 1): Mutant[] {
  if (all.length <= max) return [...all];
  // Group by line so we do not ask three questions about the same line
  const byLine = new Map<string, Mutant[]>();
  for (const m of all) {
    const key = `${m.file}:${m.line}`;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key)!.push(m);
  }
  // Prefer "interesting" operators first (logic and boundaries over literals)
  const weight: Record<OperatorId, number> = {
    'cmp-stricter': 5,
    'cmp-looser': 5,
    'and-to-or': 5,
    'or-to-and': 5,
    'eq-flip': 4,
    'drop-not': 4,
    arith: 3,
    'assign-arith': 3,
    'update-flip': 3,
    'bool-flip': 2,
    'num-plus-one': 1,
  };
  const lines = [...byLine.values()].map((ms) => ms.sort((a, b) => weight[b.operator] - weight[a.operator] || a.start - b.start));
  const rng = mulberry32(seed);
  // Shuffle lines deterministically, then take the best mutant of each line round-robin
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }
  lines.sort((a, b) => weight[b[0].operator] - weight[a[0].operator]);
  const picked: Mutant[] = [];
  let round = 0;
  while (picked.length < max) {
    let added = false;
    for (const ms of lines) {
      if (ms[round]) {
        picked.push(ms[round]);
        added = true;
        if (picked.length >= max) break;
      }
    }
    if (!added) break;
    round++;
  }
  return picked.sort((a, b) => (a.file === b.file ? a.start - b.start : a.file.localeCompare(b.file)));
}

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
