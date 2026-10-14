// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { describe, expect, it } from 'vitest'
import { APP_VERSION } from '@cascadia/commons/version'
import { resolveBuildTag } from './build-info'

describe('resolveBuildTag', () => {
  it('uses the stamp when the build passed one', () => {
    expect(resolveBuildTag('v0.6.0', true, '0.6.0')).toBe('v0.6.0')
    expect(resolveBuildTag('main', true, '0.6.0')).toBe('main')
    expect(resolveBuildTag('main', false, '0.6.0')).toBe('main')
  })

  // Cascadia-App#121: every published image read `dev`, because neither the
  // publish workflow nor the Dockerfile default supplied a stamp.
  it('falls back to the release version in an unstamped production build', () => {
    expect(resolveBuildTag(undefined, true, '0.6.0')).toBe('v0.6.0')
    expect(resolveBuildTag('', true, '0.6.0')).toBe('v0.6.0')
  })

  it('keeps `dev` for the dev server', () => {
    expect(resolveBuildTag(undefined, false, '0.6.0')).toBe('dev')
    expect(resolveBuildTag('', false, '0.6.0')).toBe('dev')
  })

  it('defaults to the package version', () => {
    expect(resolveBuildTag(undefined, true)).toBe(`v${APP_VERSION}`)
  })
})
