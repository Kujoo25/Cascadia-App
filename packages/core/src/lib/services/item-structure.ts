// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import {
  itemRelationships,
  partVariantExecutionBomLines,
  partVariantExecutions,
} from '../db/schema'

/**
 * An item's BOM structure, reduced to something two versions can be compared
 * on.
 *
 * The `items` row is not the item: a BOM edit changes no column on it. Both
 * the merge's pre-flight check and conflict detection need to know whether two
 * versions' structures diverged, and they used to answer differently — the
 * merge compared structure and refused, while detection compared only the item
 * row and reported nothing, so a BOM-only divergence on main was invisible in
 * the Conflicts tab and fatal at merge. One comparator, both callers.
 */
export interface BomStructure {
  /** Number of BOM lines, for display */
  lineCount: number
  /** Order-independent identity of the line set: child, quantity, find number */
  signature: string
}

export async function bomStructureOf(
  itemId: string,
  tx?: Pick<typeof db, 'select'>,
): Promise<BomStructure> {
  const executor = tx ?? db
  const rows = await executor
    .select({
      targetId: itemRelationships.targetId,
      quantity: itemRelationships.quantity,
      findNumber: itemRelationships.findNumber,
    })
    .from(itemRelationships)
    .where(
      and(
        eq(itemRelationships.sourceId, itemId),
        eq(itemRelationships.relationshipType, 'BOM'),
      ),
    )

  const executions = await executor
    .select({
      id: partVariantExecutions.id,
      executionMasterId: partVariantExecutions.executionMasterId,
      code: partVariantExecutions.code,
      name: partVariantExecutions.name,
      sku: partVariantExecutions.sku,
      isActive: partVariantExecutions.isActive,
      attributes: partVariantExecutions.attributes,
    })
    .from(partVariantExecutions)
    .where(eq(partVariantExecutions.partItemId, itemId))

  const executionLines =
    executions.length === 0
      ? []
      : await executor
          .select({
            executionId: partVariantExecutionBomLines.executionId,
            targetId: partVariantExecutionBomLines.targetItemId,
            quantity: partVariantExecutionBomLines.quantity,
            findNumber: partVariantExecutionBomLines.findNumber,
            referenceDesignator:
              partVariantExecutionBomLines.referenceDesignator,
          })
          .from(partVariantExecutionBomLines)
          .where(
            inArray(
              partVariantExecutionBomLines.executionId,
              executions.map((execution) => execution.id),
            ),
          )
  const masterByExecution = new Map(
    executions.map((execution) => [execution.id, execution.executionMasterId]),
  )
  const signature = [
    ...rows.map(
      (row) =>
        `B:${row.targetId}:${row.quantity ?? ''}:${row.findNumber ?? ''}`,
    ),
    ...executions.map(
      (execution) =>
        `E:${execution.executionMasterId}:${execution.code}:${execution.name ?? ''}:${execution.sku ?? ''}:${execution.isActive}:${stableJson(execution.attributes)}`,
    ),
    ...executionLines.map(
      (line) =>
        `M:${masterByExecution.get(line.executionId)}:${line.targetId}:${line.quantity}:${line.findNumber ?? ''}:${line.referenceDesignator ?? ''}`,
    ),
  ]
    .sort()
    .join('|')

  return {
    lineCount: rows.length + executionLines.length,
    signature,
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  if (value === undefined) return 'undefined'
  return JSON.stringify(value)
}

/** How a BOM structure reads in a conflict list. */
export function describeBomStructure(structure: BomStructure): string {
  return `${structure.lineCount} BOM line${structure.lineCount === 1 ? '' : 's'}`
}
