// Bundles the action and the CLI into single files with no runtime dependencies.
import { build } from 'esbuild';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: false,
  legalComments: 'none',
  // Babel's parser is CommonJS: give the ESM bundle a real `require`
  banner: { js: "import { createRequire as __capitoCreateRequire } from 'node:module';\nconst require = __capitoCreateRequire(import.meta.url);" },
};

await build({ ...shared, entryPoints: ['src/github/main.ts'], outfile: 'dist/index.js' });
await build({ ...shared, entryPoints: ['src/cli/cli.ts'], outfile: 'dist/cli.js' });

const cli = readFileSync('dist/cli.js', 'utf8');
if (!cli.startsWith('#!')) writeFileSync('dist/cli.js', '#!/usr/bin/env node\n' + cli);
chmodSync('dist/cli.js', 0o755);
console.log('Built dist/index.js and dist/cli.js');
