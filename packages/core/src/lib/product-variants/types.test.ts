// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  configurePartVariantSchema,
  createVariantExecutionSchema,
  formatExecutionDesignation,
} from './types'

describe('product variant contracts', () => {
  it('normalizes family, variant and execution codes', () => {
    expect(
      configurePartVariantSchema.parse({
        familyCode: 'p3001',
        familyName: 'Hotel setpoint controller',
        variantCode: 'v1',
      }),
    ).toMatchObject({ familyCode: 'P3001', variantCode: 'V1' })

    expect(createVariantExecutionSchema.parse({ code: 'mk2' }).code).toBe('MK2')
  })

  it('uses the parent Part revision in every execution designation', () => {
    const base = { familyCode: 'P3001', variantCode: 'V1', revision: 'R2' }

    expect(formatExecutionDesignation({ ...base, executionCode: 'MK1' })).toBe(
      'P3001V1R2MK1',
    )
    expect(formatExecutionDesignation({ ...base, executionCode: 'MK2' })).toBe(
      'P3001V1R2MK2',
    )
  })

  it('does not present a working marker as a released designation', () => {
    expect(
      formatExecutionDesignation({
        familyCode: 'P3001',
        variantCode: 'V1',
        revision: '-abcd1234',
        executionCode: 'MK1',
      }),
    ).toBe('P3001V1DRAFTMK1')
  })
})
