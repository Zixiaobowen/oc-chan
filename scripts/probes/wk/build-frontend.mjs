// node scripts/probes/wk/build-frontend.mjs /absolute/original/workspace
import { createRequire } from 'node:module';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const root = process.argv[2];
if (!root || !isAbsolute(root)) throw new Error('Explicit absolute dependency workspace root required');
const require = createRequire(resolve(root, 'package.json'));
const { build } = await import(require.resolve('vite'));
const here = dirname(fileURLToPath(import.meta.url));
await mkdir(resolve(here, 'frontend-dist'), { recursive: true });
await build({ configFile: false, root: resolve(here, 'frontend'),
  resolve: { alias: { 'react-dom/client': require.resolve('react-dom/client'), react: dirname(require.resolve('react/package.json')), three: resolve(dirname(require.resolve('three')), 'three.module.js') } },
  build: { outDir: resolve(here, 'frontend-dist'), emptyOutDir: true, minify: false }
});
await writeFile(resolve(here, 'frontend-dist/dependency-root.txt'), root + '\n');
