// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Edition manifest — the single source of truth for core vs proprietary.
 *
 * Core is everything published under AGPL-3.0-or-later. Proprietary is a
 * top-level `cascadia-*` workspace whose manifest declares `UNLICENSED`, the
 * two proprietary Python workers (which carry no npm manifest), and one
 * stale-checkout backstop. The classification is discovered, not written:
 * this file is the same file in every edition, and an edition that composes
 * licensed modules is proprietary exactly where those packages exist. In the
 * AGPL edition no workspace is `UNLICENSED` and the workers are absent, so
 * every path is core — which this file can assert about the tree it is in
 * (`--assert-community`, below), and CI does where that must hold.
 *
 * Consumed by `scripts/license-headers.mjs` (stamps each file with its
 * edition's SPDX header), `scripts/check-core-boundary.mjs` and
 * `eslint.config.js` (what core must not import), and whatever else needs to
 * know what an edition's tree contains.
 *
 * Default-core is deliberate: a new file is public unless it lives under a
 * proprietary root, so the failure mode is "we published something we meant
 * to keep" — loud and caught in review — rather than silent omission. When a
 * path is genuinely ambiguous, put it under a proprietary root.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Every workspace is a top-level `cascadia-<id>/` directory whose npm name is
 * `@cascadia/<id>`: `cascadia-api` is `@cascadia/api`, a module package
 * `cascadia-design-engine` is `@cascadia/design-engine`. These two helpers
 * are the only place that convention is spelled out.
 */
export const WORKSPACE_PREFIX = 'cascadia-'
export const workspaceDir = (id) => `${WORKSPACE_PREFIX}${id}`
export const workspaceId = (dir) =>
  dir.startsWith(WORKSPACE_PREFIX) ? dir.slice(WORKSPACE_PREFIX.length) : null

/** The `license` field of a top-level workspace's manifest, or undefined. */
function licenseOf(dir) {
  const manifest = join(ROOT, dir, 'package.json')
  if (!existsSync(manifest)) return undefined
  return JSON.parse(readFileSync(manifest, 'utf8')).license
}

/** Top-level `cascadia-*` workspaces whose manifest declares UNLICENSED. */
const unlicensedWorkspaces = readdirSync(ROOT)
  .filter(
    (dir) =>
      dir.startsWith(WORKSPACE_PREFIX) && licenseOf(dir) === 'UNLICENSED',
  )
  .sort()

/**
 * Paths belonging to a proprietary module.
 *
 * A pattern ending in `/**` matches that directory and everything under it.
 * Anything else is an exact repo-relative path. Deliberately not a glob
 * library: directory prefixes cover every case, and they stay greppable.
 */
export const PROPRIETARY = [
  // ── the proprietary packages and the app that composes them ─────────────
  // Structural, not per-file: proprietary code lives in its own workspace,
  // and the workspace says so in its manifest. Nothing to list, so nothing to
  // forget — a new module package is covered the day it declares its licence.
  ...unlicensedWorkspaces.map((dir) => `${dir}/**`),

  // ── the proprietary Python workers ───────────────────────────────────────
  // Top-level like every workspace, but not npm workspaces: no package.json,
  // so nothing to discover. The CadQuery generator and the FreeCAD runner
  // exist to serve design-engine's CAD generation. Named so that an edition
  // that has them classifies them; where they are absent the patterns match
  // nothing, which `--assert-community` relies on.
  'cascadia-workers-cad-generator/**',
  'cascadia-workers-freecad-runner/**',

  // ── generated output that must never publish ─────────────────────────────
  // Each app's drizzle config emits migration SQL into the app's own
  // `drizzle/`, where the rules above classify it. This covers the *old*
  // shared location, so a stale checkout or a hand-run drizzle-kit that
  // recreates a repo-root `drizzle/` produces something unpublishable rather
  // than an enterprise baseline in a public tree. The path is ambiguous by
  // construction — its content is whichever edition generated it — and
  // ambiguous means proprietary here.
  'drizzle/**',
]

/**
 * The application's own packages, by id — never a module, whatever the
 * manifest says. The app workspaces (`cascadia-app*`) are excluded by the
 * `app` prefix test below rather than listed, since an edition adds its own.
 */
const APP_PACKAGES = new Set(['api', 'web', 'commons', 'workers-job'])

/**
 * The proprietary module packages, by id, derived from PROPRIETARY's
 * `cascadia-<id>/**` patterns, minus the application's own packages, the apps
 * and the Python workers, none of which is ever a module. One derivation,
 * consumed by the boundary check and eslint.config.js, so a module package's
 * licence declaration is the whole registration: nothing else to remember. In
 * the AGPL edition no workspace is proprietary, so this is empty.
 */
export const MODULE_PACKAGES = [
  ...new Set(
    PROPRIETARY.map((p) => workspaceId(/^([^/]+)\//.exec(p)?.[1] ?? '')).filter(
      (id) =>
        id !== null &&
        id !== '' &&
        !APP_PACKAGES.has(id) &&
        !id.startsWith('app') &&
        // The proprietary Python workers are `cascadia-workers-*` too, and are
        // not npm packages at all.
        !id.startsWith('workers-'),
    ),
  ),
]

export const HEADERS = {
  core: [
    '// SPDX-License-Identifier: AGPL-3.0-or-later',
    '// Copyright (c) 2026 Cascadia PLM LLC',
  ],
  proprietary: [
    '// SPDX-License-Identifier: LicenseRef-Cascadia-Proprietary',
    '// Copyright (c) 2026 Cascadia PLM LLC. All rights reserved.',
  ],
}

/** Normalize to forward slashes so Windows paths compare equal to patterns. */
export function normalize(p) {
  return p.replace(/\\/g, '/')
}

/** `'core' | 'proprietary'` for a repo-relative path. */
export function editionOf(path) {
  const p = normalize(path)
  for (const pattern of PROPRIETARY) {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -2)
      if (p.startsWith(prefix)) return 'proprietary'
    } else if (p === pattern) {
      return 'proprietary'
    }
  }
  return 'core'
}

/**
 * `node scripts/edition-manifest.mjs --assert-community`
 *
 * Asserts the tree is the community edition: no workspace declares UNLICENSED,
 * no PROPRIETARY pattern matches a path that exists, and no tracked file
 * carries the proprietary SPDX identifier. Discovery is what makes this
 * necessary — a proprietary package that leaked into the public tree would
 * classify itself proprietary and pass `license:check` with its headers
 * intact, so the check that there is nothing to classify has to be its own.
 * CI runs it only where the repository is the public one.
 */
function assertCommunity() {
  const problems = []

  for (const dir of unlicensedWorkspaces) {
    problems.push(`${dir}/package.json declares an UNLICENSED workspace`)
  }
  for (const pattern of PROPRIETARY) {
    const path = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    if (unlicensedWorkspaces.includes(path)) continue
    if (existsSync(join(ROOT, path))) {
      problems.push(
        `${path} exists, and the manifest classifies it proprietary`,
      )
    }
  }

  // The identifier itself, anywhere in a text file. This file is the one
  // place it may appear: it is the header `license-headers.mjs` stamps.
  const identifier = HEADERS.proprietary[0].split(': ')[1]
  const tracked = execFileSync('git', ['ls-files'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
  })
    .split('\n')
    .filter(Boolean)
    .map(normalize)
  for (const file of tracked) {
    if (file === 'scripts/edition-manifest.mjs') continue
    if (
      !/\.(ts|tsx|js|mjs|cjs|py|md|yml|yaml|json|sql|sh|toml|txt)$/i.test(file)
    )
      continue
    // Tracked but gone from disk — a deletion not yet committed — is not a
    // header; skip rather than crash on a tree mid-change.
    if (!existsSync(join(ROOT, file))) continue
    if (readFileSync(join(ROOT, file), 'utf8').includes(identifier)) {
      problems.push(`${file} carries the proprietary SPDX identifier`)
    }
  }

  if (problems.length === 0) {
    console.log(
      '✅ Community edition: no proprietary workspace, path or header in this tree.',
    )
    return
  }
  console.error(
    `✗ This tree is not the community edition — ${problems.length} problem(s):\n`,
  )
  for (const problem of problems) console.error(`   ${problem}`)
  console.error(
    '\nThe public repository holds nothing proprietary. Whatever reached it is\n' +
      'removed, not classified.',
  )
  process.exit(1)
}

if (
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href &&
  process.argv.includes('--assert-community')
) {
  assertCommunity()
}
