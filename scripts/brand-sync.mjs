// Propagates brand.json (the single brand constant) into every packaging file.
//   1. edit brand.json   2. npm run brand:sync   3. review `git diff`
// Structured files are updated field-by-field; text files (README, listings, YAML, Dockerfile...)
// get old→new string replacement using the previous values stored in .brand-lock.json.
// Note: environment variable names (SITEVERDICT_*) are a stable API and are NOT renamed; change
// ENV_PREFIX in src/config.ts deliberately if you ever want that.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
const write = (p, s) => writeFileSync(join(root, p), s);
const brand = JSON.parse(read('brand.json'));
const lockPath = '.brand-lock.json';
const prev = existsSync(join(root, lockPath)) ? JSON.parse(read(lockPath)) : brand;
const changed = [];

function editJson(file, fn) {
  if (!existsSync(join(root, file))) return;
  const obj = JSON.parse(read(file));
  fn(obj);
  write(file, JSON.stringify(obj, null, 2) + '\n');
  changed.push(file);
}

const repoUrl = `https://github.com/${brand.githubOwner}/${brand.githubRepo}`;

editJson('package.json', (p) => {
  p.name = brand.npmPackage;
  p.mcpName = brand.registryName;
  p.bin = { [brand.binName]: 'dist/cli.js' };
  p.homepage = `${repoUrl}#readme`;
  p.repository = { type: 'git', url: `git+${repoUrl}.git` };
  p.bugs = { url: `${repoUrl}/issues` };
});
editJson('server.json', (s) => {
  s.name = brand.registryName;
  s.title = brand.displayName;
  s.websiteUrl = brand.website;
  s.repository = { url: repoUrl, source: 'github' };
  for (const pkg of s.packages ?? []) if (pkg.registryType === 'npm') pkg.identifier = brand.npmPackage;
});
editJson('manifest.json', (m) => {
  m.name = brand.slug;
  m.display_name = brand.displayName;
  m.homepage = brand.website;
  m.repository = { type: 'git', url: repoUrl };
  m.documentation = `${repoUrl}#readme`;
  m.support = `${repoUrl}/issues`;
});

// Text replacement (longest values first so "siteverdict-mcp" is handled before "siteverdict").
const KEYS = ['displayName', 'registryName', 'npmPackage', 'binName', 'githubRepo', 'githubOwner', 'website', 'supportEmail', 'name', 'slug', 'uriScheme'];
const pairs = KEYS.filter((k) => prev[k] && brand[k] && prev[k] !== brand[k])
  .map((k) => [prev[k], brand[k]])
  .sort((a, b) => b[0].length - a[0].length);

const TEXT_EXT = /\.(md|ya?ml|txt)$|^Dockerfile$/;
const SKIP = new Set(['node_modules', 'dist', '.git', 'test', 'src']);
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (TEXT_EXT.test(entry)) {
      const rel = relative(root, full);
      let s = read(rel);
      const before = s;
      for (const [from, to] of pairs) s = s.split(from).join(to);
      if (s !== before) {
        write(rel, s);
        changed.push(rel);
      }
    }
  }
}
if (pairs.length) walk(root);

write(lockPath, JSON.stringify(brand, null, 2) + '\n');
process.stdout.write(`brand: ${brand.name} (${brand.npmPackage}, ${brand.registryName})\n`);
process.stdout.write(pairs.length ? `replaced: ${pairs.map(([a, b]) => `${a} -> ${b}`).join(', ')}\n` : 'no text renames needed\n');
process.stdout.write(`updated: ${[...new Set(changed)].join(', ') || 'nothing'}\n`);
process.stdout.write('Also update: Dockerfile LABEL io.modelcontextprotocol.server.name, glama.json maintainers, icons, and re-run npm run export:tools.\n');
