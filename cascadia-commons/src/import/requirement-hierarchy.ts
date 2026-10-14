// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * A requirement hierarchy in one sheet.
 *
 * A row names its parent by item number. The parent is another row of the
 * sheet, in any order, or a requirement the design already holds. The plan
 * below puts parents before children so each can be created with its parent
 * already there, and refuses the rows no order can satisfy: a row that is
 * its own parent, and a chain of parents that loops back on itself. The
 * preview runs the same plan so the sheet shows those before upload.
 *
 * Item numbers compare case-insensitively, trimmed — the way the import
 * routes key everything they create and look up.
 */

import type { RowValidationError, ValidatedRow } from './types'

export interface HierarchyRow {
  /** The spreadsheet row, as the import reports it (row 1 is the header). */
  rowNumber: number
  itemNumber?: string | null
  parentItemNumber?: string | null
}

export interface RequirementHierarchyPlan {
  /**
   * Every row the plan accepts, in an order where a parent precedes its
   * children. Rows with no parent in the sheet keep the sheet's order.
   */
  order: Array<number>
  /** The sheet row each accepted row's parent is on, for parents in the sheet. */
  parentRow: Map<number, number>
  /** Why a row cannot be imported with the parent it names. */
  errors: Map<number, string>
  /**
   * Parent numbers the sheet names but no row defines, as written in the
   * sheet (first spelling wins): looked up in the design by the import.
   */
  externalParents: Array<string>
}

function keyOf(itemNumber: string | null | undefined): string | null {
  const key = itemNumber?.trim().toLowerCase()
  return key ? key : null
}

export function planRequirementHierarchy(
  rows: Array<HierarchyRow>,
): RequirementHierarchyPlan {
  const errors = new Map<number, string>()
  const parentRow = new Map<number, number>()
  const externalByKey = new Map<string, string>()

  // The row that defines each number. A number defined twice is the
  // validator's finding (a duplicate number), not this plan's; the first
  // definition answers here so the plan stays deterministic.
  const rowByKey = new Map<string, HierarchyRow>()
  for (const row of rows) {
    const key = keyOf(row.itemNumber)
    if (key && !rowByKey.has(key)) rowByKey.set(key, row)
  }

  // Resolve each parent reference: to a sheet row, to the design, or to an
  // error the row carries from here on.
  const parentOf = new Map<number, number>()
  for (const row of rows) {
    const parentKey = keyOf(row.parentItemNumber)
    if (!parentKey) continue
    if (parentKey === keyOf(row.itemNumber)) {
      errors.set(row.rowNumber, 'A requirement cannot be its own parent')
      continue
    }
    const parent = rowByKey.get(parentKey)
    if (parent) {
      parentOf.set(row.rowNumber, parent.rowNumber)
    } else if (!externalByKey.has(parentKey)) {
      externalByKey.set(parentKey, row.parentItemNumber!.trim())
    }
  }

  // Parents first: a row is emitted once the row it depends on has been.
  // What is left when nothing more can be emitted is on a loop, or hangs
  // off one.
  const emitted = new Set<number>()
  const order: Array<number> = []
  const pending = rows.filter((row) => !errors.has(row.rowNumber))
  let progressed = true
  while (progressed) {
    progressed = false
    for (const row of pending) {
      if (emitted.has(row.rowNumber)) continue
      const dependsOn = parentOf.get(row.rowNumber)
      if (dependsOn !== undefined && !emitted.has(dependsOn)) {
        // A parent row the plan refused cannot be waited for.
        if (errors.has(dependsOn)) {
          errors.set(
            row.rowNumber,
            `Parent requirement on row ${dependsOn} cannot be imported`,
          )
          emitted.add(row.rowNumber)
          progressed = true
        }
        continue
      }
      emitted.add(row.rowNumber)
      order.push(row.rowNumber)
      if (dependsOn !== undefined) parentRow.set(row.rowNumber, dependsOn)
      progressed = true
    }
  }
  for (const row of pending) {
    if (emitted.has(row.rowNumber)) continue
    errors.set(
      row.rowNumber,
      `Parent chain loops back on itself: ${describeLoop(row.rowNumber, parentOf, rows)}`,
    )
  }

  return {
    order,
    parentRow,
    errors,
    externalParents: [...externalByKey.values()],
  }
}

function describeLoop(
  start: number,
  parentOf: Map<number, number>,
  rows: Array<HierarchyRow>,
): string {
  const numberOf = new Map(
    rows.map((row) => [
      row.rowNumber,
      row.itemNumber?.trim() || `row ${row.rowNumber}`,
    ]),
  )
  const chain = [start]
  let current = parentOf.get(start)
  while (current !== undefined && !chain.includes(current)) {
    chain.push(current)
    current = parentOf.get(current)
  }
  if (current !== undefined) chain.push(current)
  return chain
    .map((rowNumber) => numberOf.get(rowNumber) ?? `row ${rowNumber}`)
    .join(' → ')
}

/**
 * The preview's half: run the plan over validated rows and write what it
 * finds onto them — a loop or a self-parent as an error, a parent that is
 * not in the sheet as a warning saying the design must already hold it, and
 * a parent row that has errors of its own as an error, since the import
 * will not create a child whose parent it could not create.
 */
export function validateRequirementHierarchy(
  validatedRows: Array<ValidatedRow>,
): Array<ValidatedRow> {
  const plan = planRequirementHierarchy(
    validatedRows.map((row) => ({
      rowNumber: row.rowNumber,
      itemNumber: stringOf(row.mappedData.itemNumber),
      parentItemNumber: stringOf(row.mappedData.parentItemNumber),
    })),
  )
  const byRow = new Map(validatedRows.map((row) => [row.rowNumber, row]))
  const external = new Set(plan.externalParents.map((n) => n.toLowerCase()))

  return validatedRows.map((row) => {
    const errors: Array<RowValidationError> = [...row.errors]
    const warnings = [...row.warnings]
    const planError = plan.errors.get(row.rowNumber)
    if (planError) {
      errors.push({ field: 'Parent Requirement', message: planError })
    }
    const parentRow = plan.parentRow.get(row.rowNumber)
    if (parentRow !== undefined && byRow.get(parentRow)?.isValid === false) {
      errors.push({
        field: 'Parent Requirement',
        message: `Parent requirement on row ${parentRow} has errors and will not be imported`,
      })
    }
    const parent = stringOf(row.mappedData.parentItemNumber)
    if (parent && external.has(parent.trim().toLowerCase())) {
      warnings.push({
        field: 'Parent Requirement',
        message: `${parent.trim()} is not in this file; the design must already hold it`,
      })
    }
    return {
      ...row,
      errors,
      warnings,
      isValid: errors.length === 0,
    }
  })
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
