// stage.mjs — run by `prepack`.
//
// The canonical Montaj domain skills live in the repo at /skills/<name>/SKILL.md.
// npm's "files" array cannot reference paths outside the package root, so the
// publishable bundle is *derived*: this script copies the transport-agnostic
// domain skills into the package as flat files so npm can pack them.
//
// `/skills` stays the single source of truth. The staged output (./skills/*.md
// and ./contract.md) is gitignored — it is regenerated at pack time.
//
// EXCLUDED on purpose: `native`, `mcp`, and the root `SKILL.md` — those are not
// part of the published domain bundle (they describe transport / host wiring).

import { mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const repoSkills = resolve(pkgRoot, '..', '..', 'skills');

// The agnostic domain skills that make up the published bundle.
// Each entry: { src: <path under /skills>, dest: <flat file under pkgRoot> }
const DOMAIN_SKILLS = [
  { src: 'select-takes/SKILL.md', dest: 'skills/select-takes.md' },
  { src: 'overlay/SKILL.md', dest: 'skills/overlay.md' },
  { src: 'write-overlay/SKILL.md', dest: 'skills/write-overlay.md' },
  { src: 'image-search/SKILL.md', dest: 'skills/image-search.md' },
];

const CONTRACT = { src: '_contract/SKILL.md', dest: 'contract.md' };

function stageOne({ src, dest }) {
  const from = join(repoSkills, src);
  const to = join(pkgRoot, dest);
  if (!existsSync(from)) {
    throw new Error(`Source skill not found: ${from}`);
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  return dest;
}

function main() {
  // Clean the staged output so removals in /skills don't leave stragglers.
  rmSync(join(pkgRoot, 'skills'), { recursive: true, force: true });
  rmSync(join(pkgRoot, 'contract.md'), { force: true });

  const staged = [];
  for (const skill of DOMAIN_SKILLS) staged.push(stageOne(skill));
  staged.push(stageOne(CONTRACT));

  console.log(`Staged ${staged.length} files into the @bycrux/montaj-skills package:`);
  for (const f of staged) console.log(`  ${f}`);
}

main();
