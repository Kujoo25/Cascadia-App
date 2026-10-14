// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Which build the browser is actually running.
 *
 * Distinct from `APP_VERSION` in `@/version`, and deliberately so.
 * `APP_VERSION` is the product version out of package.json — it answers "which
 * Cascadia release is this?" and moves only when upstream cuts one. It cannot
 * answer "which build of *our* tree is deployed?", because a fork's own commits
 * never touch package.json: every build between two upstream releases reports
 * the same 0.5.0.
 *
 * These constants are baked in by Vite at build time from `VITE_BUILD_*`, which
 * the image build passes through as build args — the publish workflow sets
 * them from the ref and commit it is building. They are client-only on
 * purpose: `import.meta.env` is a Vite construct, and `@/version` is imported
 * by the API server too, where esbuild would leave `import.meta.env` undefined
 * and the property read would throw at boot.
 *
 * `.git` is excluded from the Docker build context (see `.dockerignore`), so
 * the values genuinely cannot be derived inside the build — passing them in is
 * the mechanism, not a shortcut.
 */

import { APP_VERSION } from '@cascadia/commons/version'

/**
 * The tag to show when the build named none.
 *
 * A production build without a stamp is still a build of a known release, so
 * it shows that release (`v0.6.0`) rather than `dev`. Every published image
 * reported `dev` until the publish workflow passed a stamp, and an image built
 * by hand without the build args still would — which reads as "a development
 * server" to anyone filing a bug against a release. `dev` is kept for what it
 * actually describes: the Vite dev server.
 */
export function resolveBuildTag(
  stamped: string | undefined,
  isProduction: boolean,
  version: string = APP_VERSION,
): string {
  if (stamped) return stamped
  return isProduction ? `v${version}` : 'dev'
}

/**
 * The ref the build came from, e.g. `v0.6.0` or `main`. Unstamped, the release
 * version in a production build and `dev` on the dev server.
 */
export const BUILD_TAG: string = resolveBuildTag(
  import.meta.env.VITE_BUILD_TAG,
  import.meta.env.PROD,
)

/** Short commit, e.g. `578399f`. Empty when the build was not stamped. */
export const BUILD_SHA: string = import.meta.env.VITE_BUILD_SHA || ''

/** Set when the tree had uncommitted changes at build time. */
export const BUILD_DIRTY: boolean = import.meta.env.VITE_BUILD_DIRTY === 'true'

/**
 * One line for display: `v0.5.0 · 578399f`, with a `+` when the build came
 * from a dirty tree. Falls back to the tag alone when there is no commit to
 * show, which is what an unstamped build gets.
 */
export const BUILD_LABEL: string = [
  BUILD_TAG,
  BUILD_SHA && `${BUILD_SHA}${BUILD_DIRTY ? '+' : ''}`,
]
  .filter(Boolean)
  .join(' · ')
