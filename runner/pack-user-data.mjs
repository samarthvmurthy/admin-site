#!/usr/bin/env node
// One-time move to the Dell. Run on the Mac:
//   node runner/pack-user-data.mjs [path-to-career-ops]
//
// Writes two zips to ~/Downloads:
//   career-ops-userdata-<date>.zip  your personal career-ops files — exactly the
//                                   "user layer" career-ops itself defines
//                                   (USER_PATHS in update-system.mjs), plus
//                                   finished-but-unmerged batch evaluations
//   admin-runner-<date>.zip         this runner folder, without .env or logs
//
// Uses macOS's built-in `zip`. Nothing is uploaded anywhere.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] || join(homedir(), 'career-ops'));
const runnerDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(homedir(), 'Downloads');
const stamp = new Date().toISOString().slice(0, 10);

if (!existsSync(join(root, 'update-system.mjs'))) {
  console.error(`Not a career-ops checkout: ${root}`);
  process.exit(1);
}

// career-ops' own definition of which files are yours.
const { USER_PATHS, LOCAL_PATHS_FILE, parseLocalPaths } = await import(pathToFileURL(join(root, 'update-system.mjs')).href);
let localPaths = [];
try { localPaths = parseLocalPaths(readFileSync(join(root, LOCAL_PATHS_FILE), 'utf8')); } catch { /* optional */ }

const wanted = [
  ...USER_PATHS,
  ...localPaths,
  LOCAL_PATHS_FILE,
  'config/cv-facts.json',
  'config/benchmarks.yml',
  'batch/tracker-additions/',  // finished evaluations not yet merged into the tracker
];
const present = [...new Set(wanted)]
  .map((p) => p.replace(/\/$/, ''))
  .filter((p) => existsSync(join(root, p)));

const userZip = join(outDir, `career-ops-userdata-${stamp}.zip`);
execFileSync('zip', [
  '-r', '-q', '-FS', userZip, ...present,
  '-x', '*.DS_Store', 'data/applications.db*', 'reports/*-RESERVED.md', '*/node_modules/*',
], { cwd: root, stdio: 'inherit' });

const runnerZip = join(outDir, `admin-runner-${stamp}.zip`);
execFileSync('zip', [
  '-r', '-q', '-FS', runnerZip, '.',
  '-x', '.env', 'runner.log*', '*.DS_Store', 'node_modules/*',
], { cwd: runnerDir, stdio: 'inherit' });

console.log('Included from career-ops:');
present.forEach((p) => console.log(`  ${p}`));
console.log(`\nWrote:\n  ${userZip}\n  ${runnerZip}`);
console.log('\nThe first zip holds your CV, profile and tracker — copy it over your remote connection only.');
