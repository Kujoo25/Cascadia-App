// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Which edition this tree contains.
 *
 * Root scripts that need a composed schema or a registered module set have to
 * name an app, and naming `cascadia-enterprise` outright breaks the core-only
 * tree — which is exactly what a core-only checkout is, and how this
 * was found. Resolving at runtime lets one script serve both editions:
 * enterprise when it is present, community otherwise.
 *
 * `CASCADIA_APP` overrides, for running community tooling against a full
 * checkout.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** App names, most specific edition first. */
const APPS = ['cascadia-enterprise', 'cascadia']

/**
 * The workspace directory holding an app's composition root.
 *
 * `cascadia` -> `cascadia-app`, `cascadia-enterprise` -> `cascadia-app-enterprise`.
 * Anything else is not an app name, and mapping it would invent a plausible
 * path that cannot exist — so this refuses rather than returning one.
 */
export function appDir(app) {
  if (app === 'cascadia') return 'cascadia-app'
  if (app.startsWith('cascadia-')) {
    return `cascadia-app-${app.slice('cascadia-'.length)}`
  }
  throw new Error(
    `Not an app name: ${app}. App names are 'cascadia' or 'cascadia-<edition>'.`,
  )
}

/** The app *name* this tree should use — see the note above on name vs directory. */
export function resolveApp(repoRoot = process.cwd()) {
  const override = process.env.CASCADIA_APP
  if (override) {
    // The directory is the string a caller has in front of them, so passing it
    // here is the likely slip. Caught before appDir(), which refuses it.
    if (override.startsWith('cascadia-app')) {
      const suffix = override.replace(/^cascadia-app-?/, '')
      throw new Error(
        `CASCADIA_APP takes an app's name, not its directory: ${override} is ` +
          `the directory. Use CASCADIA_APP=${suffix ? `cascadia-${suffix}` : 'cascadia'}.`,
      )
    }
    if (!existsSync(resolve(repoRoot, appDir(override)))) {
      throw new Error(
        `CASCADIA_APP names a missing app: ${override} (looked for ${appDir(override)}/).`,
      )
    }
    return override
  }
  for (const app of APPS) {
    if (existsSync(resolve(repoRoot, appDir(app)))) return app
  }
  throw new Error(
    'No cascadia-app* directory at the repo root — cannot resolve an edition.',
  )
}

/**
 * The tsconfig to run an app's code under, for tsx.
 *
 * tsx resolves `paths` from the tsconfig nearest the working directory — the
 * root one, when a script runs from the repo root — and the root tsconfig maps
 * `@/` across the application packages only. It is the same file in every
 * tree, so it cannot name the module packages an edition composes; the app's
 * own tsconfig does, and module code imports its own files through `@/`.
 * Anything that loads an app's composition roots — the dev server, the jobs
 * worker, the schema re-export, the OpenAPI snapshot — therefore runs under
 * `tsx --tsconfig <this>`. Vite and esbuild already read the same file
 * (scripts/build-app.mjs); this gives tsx the same view. See scripts/app-tsx.mjs.
 */
export function appTsconfig(app = resolveApp()) {
  return `${appDir(app)}/tsconfig.json`
}
