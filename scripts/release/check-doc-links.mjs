#!/usr/bin/env node
/**
 * Documentation link checker.
 *
 * The public docs are the product for anyone who has not cloned the repo yet:
 * a README that points at a file which no longer exists costs more trust than
 * a missing feature, because it is evidence nobody read the page. Legacy docs
 * were deleted during the open-source cleanup and every link into them looked
 * fine in a diff, so this runs in CI instead of relying on someone noticing.
 *
 * It walks every Markdown file git knows about (tracked, plus new files that
 * are not ignored), resolves every relative link and image path, and fails on
 * the first target that does not exist on disk.
 *
 * ONE allowance: screenshots. They are captured after the docs are written, so
 * a missing PNG under docs/screenshots/ is permitted IF its filename is listed
 * in docs/screenshots/README.md. That list is the manifest of what is meant to
 * be captured — a screenshot referenced by a doc but absent from the manifest
 * is a typo, and a screenshot in the manifest that never lands is caught by the
 * capture step, not here.
 *
 * Run: node scripts/release/check-doc-links.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/** Tracked files plus untracked-but-not-ignored ones, so new docs are checked. */
function markdownFiles() {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  return [...new Set(out.split('\n'))]
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !f.includes('node_modules/'))
    // `git ls-files -c` still lists a file whose deletion is only in the
    // worktree. Checking links in a file that is not there is not useful.
    .filter((f) => existsSync(join(ROOT, f)))
    .sort();
}

/** Screenshot filenames the manifest says are yet to be captured. */
function screenshotManifest() {
  const manifest = join(ROOT, 'docs/screenshots/README.md');
  if (!existsSync(manifest)) return new Set();

  const names = readFileSync(manifest, 'utf8').match(/[\w.-]+\.(?:png|jpg|jpeg|gif|webp|svg)/gi);
  return new Set((names ?? []).map((n) => n.toLowerCase()));
}

/**
 * Every link target in a Markdown file, with the line it appeared on.
 *
 * Covers inline links and images `[a](b)` / `![a](b)`, angle-bracketed
 * destinations `[a](<b>)`, reference definitions `[a]: b`, and raw `<img src>`
 * / `<a href>` — the README lays screenshots out in an HTML table, so an
 * HTML-blind checker would silently skip exactly the links most likely to rot.
 */
function targetsIn(text) {
  const found = [];
  const lines = text.split('\n');

  // Fenced code blocks are examples, not links. A spec that shows a
  // `[label](path)` snippet inside a fence is documenting syntax.
  let inFence = false;

  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const lineNo = i + 1;
    const push = (raw) => found.push({ raw, lineNo });

    for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) push(m[1]);
    for (const m of line.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/g)) push(m[1]);
    for (const m of line.matchAll(/<(?:img|source)[^>]*\ssrc="([^"]+)"/gi)) push(m[1]);
    for (const m of line.matchAll(/<a[^>]*\shref="([^"]+)"/gi)) push(m[1]);
  });

  return found;
}

const EXTERNAL = /^(?:https?:|mailto:|tel:|data:|#|\{\{)/i;

const files = markdownFiles();
const allowedMissingScreenshots = screenshotManifest();
const failures = [];
let checked = 0;

for (const file of files) {
  const abs = join(ROOT, file);
  const text = readFileSync(abs, 'utf8');

  for (const { raw, lineNo } of targetsIn(text)) {
    if (EXTERNAL.test(raw)) continue;

    // Strip the anchor and any query string; a link to a heading inside an
    // existing file is the file's problem to keep true, not this script's.
    const path = raw.split('#')[0].split('?')[0];
    if (!path) continue;

    const target = path.startsWith('/')
      ? join(ROOT, normalize(path))
      : resolve(dirname(abs), path);

    checked++;
    if (existsSync(target)) continue;

    const rel = relative(ROOT, target);
    const isScreenshot = rel.startsWith('docs/screenshots/');
    const basename = rel.split('/').pop().toLowerCase();

    if (isScreenshot && allowedMissingScreenshots.has(basename)) continue;

    failures.push(
      `${file}:${lineNo}: link target does not exist -> ${raw}` +
        (isScreenshot
          ? `\n    Screenshots may be missing only while listed in docs/screenshots/README.md.` +
            `\n    "${basename}" is not in that manifest.`
          : `\n    Resolved to ${rel}`)
    );
  }
}

if (failures.length > 0) {
  console.error(`\nDoc links: ${failures.length} broken link(s)\n`);
  for (const f of failures) console.error(`  x ${f}\n`);
  process.exit(1);
}

console.log('Doc links: clean');
console.log(`  ${files.length} markdown files, ${checked} relative links resolved`);
if (allowedMissingScreenshots.size > 0) {
  console.log(`  ${allowedMissingScreenshots.size} screenshot(s) allowed pending capture`);
}
