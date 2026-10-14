// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The requirement hierarchy plan — the order a sheet's rows import in, and
 * the rows no order can satisfy. Complex-algorithm gate, like the BOM
 * parser: a wrong order creates a child before its parent and the import
 * reports a missing parent for a row that named one correctly.
 */

import { describe, expect, it } from 'vitest'
import {
  planRequirementHierarchy,
  validateRequirementHierarchy,
} from './requirement-hierarchy'
import type { ValidatedRow } from './types'

const row = (
  rowNumber: number,
  itemNumber: string | undefined,
  parentItemNumber?: string,
) => ({ rowNumber, itemNumber, parentItemNumber })

describe('planRequirementHierarchy', () => {
  it('puts every parent before its children whatever the sheet order, keeping the sheet order otherwise', () => {
    const plan = planRequirementHierarchy([
      row(2, 'REQ-1-D1', 'REQ-1'),
      row(3, 'REQ-2'),
      row(4, 'REQ-1-D1-D1', 'REQ-1-D1'),
      row(5, 'REQ-1'),
      row(6, 'REQ-2-D1', 'REQ-2'),
    ])
    expect(plan.errors.size).toBe(0)
    expect(plan.externalParents).toEqual([])
    expect(plan.order).toEqual([3, 5, 6, 2, 4])
    expect([...plan.parentRow]).toEqual([
      [6, 3],
      [2, 5],
      [4, 2],
    ])
  })

  it('matches parents by number case-insensitively and trimmed', () => {
    const plan = planRequirementHierarchy([
      row(2, 'req-1-d1', ' REQ-1 '),
      row(3, 'REQ-1'),
    ])
    expect(plan.order).toEqual([3, 2])
    expect(plan.parentRow.get(2)).toBe(3)
  })

  it('leaves a parent the sheet does not define to the design, once per number', () => {
    const plan = planRequirementHierarchy([
      row(2, 'REQ-9-D1', 'REQ-9'),
      row(3, 'REQ-9-D2', 'req-9'),
      row(4, 'REQ-8-D1', 'REQ-8'),
    ])
    expect(plan.errors.size).toBe(0)
    expect(plan.order).toEqual([2, 3, 4])
    expect(plan.parentRow.size).toBe(0)
    expect(plan.externalParents).toEqual(['REQ-9', 'REQ-8'])
  })

  it('refuses a row that is its own parent, and the rows that hang off it', () => {
    const plan = planRequirementHierarchy([
      row(2, 'REQ-1', 'REQ-1'),
      row(3, 'REQ-1-D1', 'REQ-1'),
      row(4, 'REQ-2'),
    ])
    expect(plan.order).toEqual([4])
    expect(plan.errors.get(2)).toBe('A requirement cannot be its own parent')
    expect(plan.errors.get(3)).toBe(
      'Parent requirement on row 2 cannot be imported',
    )
  })

  it('refuses a parent chain that loops, naming the loop, and imports the rest', () => {
    const plan = planRequirementHierarchy([
      row(2, 'REQ-A', 'REQ-C'),
      row(3, 'REQ-B', 'REQ-A'),
      row(4, 'REQ-C', 'REQ-B'),
      row(5, 'REQ-D', 'REQ-A'),
      row(6, 'REQ-E'),
    ])
    expect(plan.order).toEqual([6])
    for (const rowNumber of [2, 3, 4, 5]) {
      expect(plan.errors.get(rowNumber)).toContain('loops back on itself')
    }
    expect(plan.errors.get(2)).toBe(
      'Parent chain loops back on itself: REQ-A → REQ-C → REQ-B → REQ-A',
    )
  })

  it('cannot be referenced without a number: a parent nobody defines is external', () => {
    const plan = planRequirementHierarchy([
      row(2, undefined),
      row(3, 'REQ-X-D1', 'REQ-X'),
    ])
    expect(plan.order).toEqual([2, 3])
    expect(plan.externalParents).toEqual(['REQ-X'])
  })
})

describe('validateRequirementHierarchy', () => {
  const validated = (
    rowNumber: number,
    mappedData: Record<string, unknown>,
    errors: ValidatedRow['errors'] = [],
  ): ValidatedRow => ({
    rowNumber,
    rawData: mappedData,
    mappedData,
    errors,
    warnings: [],
    isValid: errors.length === 0,
  })

  it('writes the plan onto the rows: a loop is an error, an external parent a warning, a broken parent row an error', () => {
    const rows = validateRequirementHierarchy([
      validated(2, { itemNumber: 'REQ-1', parentItemNumber: 'REQ-2' }),
      validated(3, { itemNumber: 'REQ-2', parentItemNumber: 'REQ-1' }),
      validated(4, { itemNumber: 'REQ-3', parentItemNumber: 'REQ-0' }),
      validated(5, { itemNumber: 'REQ-4' }, [
        { field: 'Title', message: 'Title is required' },
      ]),
      validated(6, { itemNumber: 'REQ-4-D1', parentItemNumber: 'REQ-4' }),
      validated(7, { itemNumber: 'REQ-5' }),
    ])
    const byRow = new Map(rows.map((r) => [r.rowNumber, r]))

    expect(byRow.get(2)?.isValid).toBe(false)
    expect(byRow.get(2)?.errors[0]?.message).toContain('loops back')
    expect(byRow.get(3)?.isValid).toBe(false)

    expect(byRow.get(4)?.isValid).toBe(true)
    expect(byRow.get(4)?.warnings[0]?.message).toBe(
      'REQ-0 is not in this file; the design must already hold it',
    )

    expect(byRow.get(6)?.isValid).toBe(false)
    expect(byRow.get(6)?.errors[0]?.message).toBe(
      'Parent requirement on row 5 has errors and will not be imported',
    )

    expect(byRow.get(7)?.isValid).toBe(true)
    expect(byRow.get(7)?.warnings).toEqual([])
  })
})
