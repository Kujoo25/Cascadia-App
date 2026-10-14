// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import type { TransactionClient } from '@/db'
import { db } from '@/db'
import { items, testCases } from '@/db/schema'

type Run = TransactionClient | typeof db

/**
 * The master behind the test plan a caller names. Callers name plans by the
 * row id they hold (the page's link, the picker's value); what is stored is
 * the master, so membership survives whatever revises either side.
 */
async function planMasterIdOf(
  run: Run,
  data: { testPlanMasterId?: unknown; testPlanId?: unknown },
): Promise<string | null | undefined> {
  if (typeof data.testPlanMasterId === 'string' && data.testPlanMasterId) {
    return data.testPlanMasterId
  }
  if (data.testPlanId === undefined && data.testPlanMasterId === undefined) {
    return undefined
  }
  if (typeof data.testPlanId !== 'string' || !data.testPlanId) return null
  const [plan] = await run
    .select({ masterId: items.masterId })
    .from(items)
    .where(eq(items.id, data.testPlanId))
    .limit(1)
  return plan?.masterId ?? null
}

/** The row that currently answers for a plan master, for the page's link. */
async function currentPlanRowId(
  run: Run,
  masterId: string,
): Promise<string | null> {
  const rows = await run
    .select({ id: items.id, isCurrent: items.isCurrent })
    .from(items)
    .where(
      and(
        inArray(items.masterId, [masterId]),
        eq(items.itemType, 'TestPlan'),
        eq(items.isDeleted, false),
      ),
    )
  return (rows.find((row) => row.isCurrent) ?? rows[0])?.id ?? null
}

registerTypeHandler('TestCase', {
  table: testCases,

  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(testCases).values({
      itemId,
      testPlanMasterId: (await planMasterIdOf(run, data)) ?? null,
      testType: data.testType || null,
      preconditions: data.preconditions || null,
      steps: data.steps || null,
      executionStatus: data.executionStatus || null,
      lastExecutedAt: data.lastExecutedAt || null,
      lastExecutedBy: data.lastExecutedBy || null,
      environment: data.environment || null,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [tc] = await run
      .select()
      .from(testCases)
      .where(eq(testCases.itemId, itemId))
      .limit(1)
    if (!tc) return tc
    // The stored pointer is the master; the page links to a row.
    return {
      ...tc,
      testPlanId: tc.testPlanMasterId
        ? await currentPlanRowId(run, tc.testPlanMasterId)
        : null,
    }
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    const planMasterId = await planMasterIdOf(run, data)
    if (planMasterId !== undefined) updateData.testPlanMasterId = planMasterId
    if (data.testType !== undefined) updateData.testType = data.testType || null
    if (data.preconditions !== undefined)
      updateData.preconditions = data.preconditions || null
    if (data.steps !== undefined) updateData.steps = data.steps || null
    if (data.executionStatus !== undefined)
      updateData.executionStatus = data.executionStatus || null
    if (data.lastExecutedAt !== undefined)
      updateData.lastExecutedAt = data.lastExecutedAt || null
    if (data.lastExecutedBy !== undefined)
      updateData.lastExecutedBy = data.lastExecutedBy || null
    if (data.environment !== undefined)
      updateData.environment = data.environment || null

    if (Object.keys(updateData).length > 0) {
      await run
        .update(testCases)
        .set(updateData)
        .where(eq(testCases.itemId, itemId))
    }
  },
})
