import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(projectRoot, 'dist');
const pagesDir = path.join(projectRoot, 'docs');

if (!existsSync(path.join(buildDir, 'index.html'))) {
  throw new Error('Production build not found. Run `npm run build` before staging Pages.');
}

mkdirSync(pagesDir, { recursive: true });
for (const entry of readdirSync(buildDir)) {
  const source = path.join(buildDir, entry);
  const destination = path.join(pagesDir, entry);
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}
writeFileSync(path.join(pagesDir, '.nojekyll'), '');
console.log(`GitHub Pages files staged in ${path.relative(projectRoot, pagesDir)}/`);
