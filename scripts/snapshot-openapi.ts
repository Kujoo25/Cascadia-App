// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

//
// Generate or verify the committed OpenAPI v1 snapshots.
//
// `docs/api/openapi.v1.json` is the frozen v1 contract of the community
// edition. It is the same file in every tree, whichever edition the tree
// composes: a tree that composes an edition with licensed modules carries that
// edition's contract as well, beside its composition root
// (`<app directory>/openapi.v1.json`) — the community contract plus the
// endpoints the modules contribute. `openapi:check` verifies every snapshot
// the tree has an app for, so a route change lands with both regenerated.
//
// Usage:
//   npm run openapi:snapshot                              # writes every snapshot this tree has an app for
//   npm run openapi:check                                 # fails on a stale snapshot, any of them
//   tsx scripts/snapshot-openapi.ts --print | jq '.info'  # the community spec, to stdout
//   tsx scripts/snapshot-openapi.ts --app <name> --out <path> [--check|--print]
//
// Registering an app's modules is additive and global, and contributed routes
// mount while the server is being built, so one process can describe exactly
// one edition. Asked for every snapshot, this script runs itself once per app,
// community first.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { appDir, appTsconfig, resolveApp } from './edition.mjs'

/** The value after `name`, or undefined. Bind, then guard — see CLAUDE.md. */
function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

const args = new Set(process.argv.slice(2))
const REPO = resolve(import.meta.dirname, '..')
const COMMUNITY_APP = 'cascadia'

/** Where an app's contract is committed. */
function snapshotPathFor(app: string): string {
  return app === COMMUNITY_APP
    ? resolve(REPO, 'docs', 'api', 'openapi.v1.json')
    : resolve(REPO, appDir(app), 'openapi.v1.json')
}

const explicitApp = flagValue('--app')

// No app named: do every snapshot this tree has an app for, one child per
// app. The community app exists in every tree; the composed edition is a
// second app only where one is present (`CASCADIA_APP` overrides, as it does
// for every other edition-aware script). Each child runs under its app's
// tsconfig, which is what resolves `@/` inside the modules that app composes.
if (explicitApp === undefined) {
  const composed = resolveApp()
  const mode = args.has('--check')
    ? '--check'
    : args.has('--print')
      ? '--print'
      : null
  const apps =
    mode === '--print' || composed === COMMUNITY_APP
      ? [COMMUNITY_APP]
      : [COMMUNITY_APP, composed]
  for (const app of apps) {
    execFileSync(
      'npx',
      [
        'tsx',
        '--tsconfig',
        appTsconfig(app),
        'scripts/snapshot-openapi.ts',
        '--app',
        app,
        '--out',
        snapshotPathFor(app),
        ...(mode ? [mode] : []),
      ],
      { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32' },
    )
  }
  process.exit(0)
}

// Silence the application's pino logger so it doesn't interleave with the
// generated JSON on stdout. Must precede the dynamic import below.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent'

// Attach the app's modules before the server is imported, so their contributed
// routes appear in the spec. The order is load-bearing — route contributions
// mount while the routers are being built. See the note in `src/server/dev.ts`.
// The community app registers nothing, which is what makes its spec the
// community contract in a tree that also composes modules.
const { registerModules } = (await import(
  `../${appDir(explicitApp)}/src/modules.server`
)) as { registerModules: () => void }
registerModules()

const { default: app } = await import('@cascadia/api/server')

const outPath = flagValue('--out')
const SNAPSHOT_PATH = outPath
  ? resolve(process.cwd(), outPath)
  : snapshotPathFor(explicitApp)

/**
 * Recursively sort object keys so the serialized snapshot is order-stable
 * across runs (otherwise tiny hash-order changes appear as diff noise).
 */
function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as never
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out as T
  }
  return value
}

async function generate(): Promise<string> {
  const res = await app.fetch(new Request('http://local/openapi.json'))
  if (!res.ok) {
    throw new Error(`openapi.json returned ${res.status}: ${await res.text()}`)
  }
  const spec = await res.json()
  return JSON.stringify(sortKeys(spec), null, 2) + '\n'
}

const generated = await generate()

if (args.has('--print')) {
  process.stdout.write(generated)
  process.exit(0)
}

if (args.has('--check')) {
  if (!existsSync(SNAPSHOT_PATH)) {
    console.error(
      `OpenAPI snapshot missing at ${SNAPSHOT_PATH}. Run \`npm run openapi:snapshot\` and commit the result.`,
    )
    process.exit(1)
  }
  // Normalize CRLF: on Windows clones autocrlf smudges the snapshot to CRLF
  // on checkout, which must not read as contract drift.
  const committed = readFileSync(SNAPSHOT_PATH, 'utf8').replace(/\r\n/g, '\n')
  if (committed !== generated) {
    console.error(
      `OpenAPI snapshot is out of date. Run \`npm run openapi:snapshot\` and commit ${SNAPSHOT_PATH}.`,
    )
    process.exit(1)
  }
  console.log(`OpenAPI snapshot is up to date: ${SNAPSHOT_PATH}`)
  process.exit(0)
}

mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true })
writeFileSync(SNAPSHOT_PATH, generated)
console.log(`Wrote ${SNAPSHOT_PATH}`)
// Importing the server app leaves the event loop alive (db pool); exit
// explicitly like --check does or this hangs after a successful write.
process.exit(0)
