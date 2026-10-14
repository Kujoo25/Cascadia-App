// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/db'
import { requirements } from '@/db/schema'

/**
 * `requirementType` is the API's name for the column the table and the
 * `Requirement` interface both call `type`. The create schema, the AI
 * `create_item` tool (`ai/tools/write-handlers.ts`) and the design
 * engine's draft artifacts all spell it that way, so the alias is resolved
 * here — in one place, honoured by every caller including
 * `PUT /api/v1/requirements/:id` and the generic `PUT /api/v1/items/:id`,
 * neither of which stored it before. An explicit `type` wins when a request
 * carries both.
 */
function resolveType(data: {
  type?: string | null
  requirementType?: string | null
}): string | null | undefined {
  return data.type !== undefined ? data.type : data.requirementType
}

registerTypeHandler('Requirement', {
  table: requirements,

  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(requirements).values({
      itemId,
      description: data.description || null,
      type: resolveType(data) || null,
      priority: data.priority || null,
      acceptanceCriteria: data.acceptanceCriteria || null,
      source: data.source || null,
      category: data.category || null,
      verificationMethod: data.verificationMethod || null,
      // Derived, never taken from the caller: a new requirement verifies
      // nothing yet (services/verification-rollup.ts recomputes it as links
      // and executions arrive), and a waiver is its own request.
      verificationStatus: 'NotStarted',
      verificationWaiver: null,
      parentRequirementId: data.parentRequirementId || null,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [requirement] = await run
      .select()
      .from(requirements)
      .where(eq(requirements.itemId, itemId))
      .limit(1)
    return requirement
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    if (data.description !== undefined)
      updateData.description = data.description || null
    const typeValue = resolveType(data)
    if (typeValue !== undefined) updateData.type = typeValue || null
    if (data.priority !== undefined) updateData.priority = data.priority || null
    if (data.acceptanceCriteria !== undefined)
      updateData.acceptanceCriteria = data.acceptanceCriteria || null
    if (data.source !== undefined) updateData.source = data.source || null
    if (data.category !== undefined) updateData.category = data.category || null
    if (data.verificationMethod !== undefined)
      updateData.verificationMethod = data.verificationMethod || null
    // `verificationStatus` and `verificationWaiver` are deliberately not
    // writable here: the rollup and the waiver endpoint own them.
    if (data.parentRequirementId !== undefined)
      updateData.parentRequirementId = data.parentRequirementId || null

    if (Object.keys(updateData).length > 0) {
      await run
        .update(requirements)
        .set(updateData)
        .where(eq(requirements.itemId, itemId))
    }
  },
})
