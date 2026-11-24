#!/usr/bin/env node
/**
 * Pack the release tarball as `../releases/dsh-superagent-panel-<version>.tgz`.
 *
 * `npm pack` derives the file name from the package name, and this package is scoped (`@mystic7c/…`), so the raw output is
 * `mystic7c-dsh-superagent-panel-<version>.tgz`. Every consumer — `docs/delivery.md`, `docs/self-development.md`, and
 * `scripts/local-install.mjs`' default lookup — uses the unscoped name, so the rename belongs in one place: here.
 *
 *   npm run pack:release        # = node scripts/pack-release.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const releasesDir = join(repoRoot, '..', 'releases')
mkdirSync(releasesDir, { recursive: true })

execFileSync('npm', ['pack', '--pack-destination', releasesDir], { cwd: repoRoot, stdio: 'inherit' })

const baseName = pkg.name.includes('/') ? pkg.name.split('/').pop() : pkg.name
const packed = join(releasesDir, `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`)
const target = join(releasesDir, `${baseName}-${pkg.version}.tgz`)
if (!existsSync(packed)) throw new Error(`npm pack produced no ${packed}`)
renameSync(packed, target)
console.log(target)
