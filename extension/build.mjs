import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'src/background.ts')],
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  outfile: join(out, 'background.js'),
});
cpSync(join(root, 'manifest.json'), join(out, 'manifest.json'));
console.log('extension built ->', out);
