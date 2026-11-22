/**
 * Tiny glob matcher (no dependencies). Supports `**`, `*`, `?` and `{a,b}`.
 * Paths are always matched with forward slashes, relative to the repo root.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  let inGroup = false;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories, `**` alone matches everything
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      inGroup = true;
      re += '(?:';
    } else if (c === '}' && inGroup) {
      inGroup = false;
      re += ')';
    } else if (c === ',' && inGroup) {
      re += '|';
    } else if ('\\^$+.()|[]'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
    i++;
  }
  return new RegExp('^' + re + '$');
}

export function makeMatcher(include: string[], exclude: string[]): (path: string) => boolean {
  const inc = include.map(globToRegExp);
  const exc = exclude.map(globToRegExp);
  return (path: string) => {
    const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
    return inc.some((r) => r.test(p)) && !exc.some((r) => r.test(p));
  };
}

export const DEFAULT_INCLUDE = ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'];

export const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/vendor/**',
  '**/*.d.ts',
  '**/*.min.js',
  '**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/__fixtures__/**',
  '**/test/**',
  '**/tests/**',
  '**/e2e/**',
  '**/fixtures/**',
  '**/*.stories.{js,jsx,ts,tsx}',
  '**/*.config.{js,ts,mjs,cjs,mts,cts}',
  '**/.*/**',
];

/**
 * Split a multi-line / comma separated action input into a list.
 * Commas inside `{...}` (glob alternatives) are kept.
 */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '{') depth++;
    if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === '\n' || (ch === ',' && depth === 0)) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
