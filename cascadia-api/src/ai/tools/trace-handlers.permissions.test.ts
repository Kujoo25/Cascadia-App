// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AI/MCP trace tools — program isolation and the affirm gate
 *
 * Security gate. `get_suspect_links` takes a design or an item id and nothing
 * else, and `affirm_link` takes an edge id: the wrapper's RBAC check is
 * instance-blind, so a chatbot user or an MCP agent holding `parts:read`
 * could otherwise list another program's trace graph by knowing a UUID, and
 * one holding `parts:update` could affirm its claims. Both users hold the
 * same role and differ only in program membership, so a refusal can only
 * come from the instance gate. The MCP leg drives the same handlers through
 * `toolRegistry[].invoke` with a `keyScope`, proving the gate sits below both
 * surfaces.
 *
 * Run: npx vitest run cascadia-api/src/ai/tools/trace-handlers.permissions.test.ts
 */

import { randomUUID } from 'node:crypto'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getSuspectLinksHandler } from './handlers'
import { affirmLinkHandler } from './write-handlers'
import { toolRegistry } from './registry'
import type { ToolContext } from './permission-wrapper'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@cascadia/commons/items/types/part'
import type { Requirement } from '@cascadia/commons/items/types/requirement'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { ItemService } from '@/items/services/ItemService'
import { affirmationOf, withAffirmation } from '@/items/trace-affirmation'
import { DesignService } from '@/services/DesignService'
import { ProgramService } from '@/services/ProgramService'
import { RequirementService } from '@/services/RequirementService'
import { permissionService } from '@/auth/permission-service'
import { PermissionDeniedError } from '@/errors'
import { itemRelationships } from '@/db/schema'

// Import to register item types
import '@/items/registerItemTypes.server'

interface AffirmEnvelope {
  success?: boolean
  error?: string
  requiresConfirmation: boolean
  confirmationToken?: string
  suspect?: boolean
}

describe('AI trace tools — program isolation and the affirm gate', () => {
  const testDb = new TestDatabase()

  let member: TestUser
  let outsider: TestUser
  let designId: string
  let partId: string
  let requirementId: string
  let satisfiesId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    // Identical grants for both, and no programs:manage.
    const engineerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`AI Trace Engineer ${randomUUID().slice(0, 8)}`, {
        parts: ['create', 'read', 'update'],
        requirements: ['create', 'read', 'update'],
        designs: ['create', 'read'],
      }),
    )
    member = await insertTestUser(testDb.db)
    outsider = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, member.id, engineerRole.id)
    await assignRoleToUser(testDb.db, outsider.id, engineerRole.id)
    permissionService.clearCache()

    const program = await ProgramService.create(
      {
        name: 'AI Trace Program',
        code: `AITR-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      member.id,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'AI Trace Design',
        code: `AITRD-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
        designType: 'Engineering',
      },
      member.id,
    )
    designId = design.id
    await ProgramService.create(
      {
        name: 'AI Trace Outsider Program',
        code: `AITRO-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      outsider.id,
    )

    const part = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId,
        revision: 'A',
        name: 'Battery tray',
        partType: 'Manufacture',
      },
      member.id,
    )
    const requirement = await ItemService.create<Requirement>(
      'Requirement',
      {
        itemType: 'Requirement',
        designId,
        revision: 'A',
        name: 'The cart shall carry 24 V packs',
      },
      member.id,
    )
    partId = part.id!
    requirementId = requirement.id!
    await RequirementService.linkSatisfaction(
      requirementId,
      [partId],
      member.id,
    )

    // Make the claim suspect without a change-order cycle: an affirmation
    // naming a row the edge no longer hangs off reads as source_revised,
    // which is all these gates need. The arithmetic itself is pinned in
    // items/trace-affirmation.test.ts.
    const [edge] = await testDb.db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, partId),
          eq(itemRelationships.relationshipType, 'SATISFIES'),
        ),
      )
    satisfiesId = edge!.id
    const affirmation = affirmationOf(edge!.metadata)!
    await testDb.db
      .update(itemRelationships)
      .set({
        metadata: withAffirmation(edge!.metadata, {
          ...affirmation,
          sourceId: randomUUID(),
        }),
      })
      .where(eq(itemRelationships.id, satisfiesId))
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  const ctx = (
    user: TestUser,
    extra: Partial<ToolContext> = {},
  ): ToolContext => ({ userId: user.id, ...extra })

  async function affirmedBy(): Promise<string | null> {
    const [edge] = await testDb.db
      .select({ metadata: itemRelationships.metadata })
      .from(itemRelationships)
      .where(eq(itemRelationships.id, satisfiesId))
    return affirmationOf(edge?.metadata)?.affirmedBy ?? null
  }

  it('lists the suspect claim for a member, by design and by item', async () => {
    const byDesign = await getSuspectLinksHandler({ designId }, ctx(member))
    expect(byDesign.total).toBe(1)
    expect(byDesign.suspectTotal).toBe(1)
    expect(byDesign.links[0]).toMatchObject({
      relationshipId: satisfiesId,
      relationshipType: 'SATISFIES',
      source: { itemId: partId },
      target: { itemId: requirementId },
      suspect: true,
      suspectReasons: ['source_revised'],
    })

    const byItem = await getSuspectLinksHandler(
      { itemId: requirementId },
      ctx(member),
    )
    expect(byItem.links.map((link) => link.relationshipId)).toEqual([
      satisfiesId,
    ])
  })

  it('refuses an outsider the listing, by design and by item', async () => {
    await expect(
      getSuspectLinksHandler({ designId }, ctx(outsider)),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
    await expect(
      getSuspectLinksHandler({ itemId: requirementId }, ctx(outsider)),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('affirms for a member through the two-step flow, and the claim reads affirmed', async () => {
    const preview = (await affirmLinkHandler(
      { relationshipId: satisfiesId },
      ctx(member),
    )) as AffirmEnvelope
    expect(preview.requiresConfirmation).toBe(true)
    expect(typeof preview.confirmationToken).toBe('string')
    // Nothing written on the preview leg.
    expect(await affirmedBy()).toBe(member.id)

    const confirmed = (await affirmLinkHandler(
      {
        relationshipId: satisfiesId,
        confirmationToken: preview.confirmationToken,
      },
      ctx(member),
    )) as AffirmEnvelope
    expect(confirmed.success).toBe(true)
    expect(confirmed.suspect).toBe(false)
    expect(
      (await getSuspectLinksHandler({ designId }, ctx(member))).total,
    ).toBe(0)
  })

  it('refuses an outsider the affirm at the preview step, writing nothing', async () => {
    const response = (await affirmLinkHandler(
      { relationshipId: satisfiesId },
      ctx(outsider),
    )) as AffirmEnvelope
    expect(response.success).toBe(false)
    expect(response.error).toBeTruthy()
    expect(response.confirmationToken).toBeUndefined()

    const [edge] = await testDb.db
      .select({ metadata: itemRelationships.metadata })
      .from(itemRelationships)
      .where(eq(itemRelationships.id, satisfiesId))
    expect(affirmationOf(edge!.metadata)?.sourceId).not.toBe(partId)
  })

  it('refuses over MCP too, with a scoped key', async () => {
    const list = toolRegistry.find((e) => e.name === 'get_suspect_links')!
    const affirm = toolRegistry.find((e) => e.name === 'affirm_link')!

    // The outsider, with a full key: refused by the instance gate.
    const outsiderContext = ctx(outsider, {
      keyScope: { parts: ['create', 'read', 'update'] },
    })
    await expect(
      list.invoke({ designId }, outsiderContext),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
    const refused = (await affirm.invoke(
      { relationshipId: satisfiesId },
      outsiderContext,
    )) as AffirmEnvelope
    expect(refused.success).toBe(false)

    // The member, with a key that cannot update parts: refused by the
    // wrapper, which intersects the key's scope with the role's grants.
    await expect(
      affirm.invoke(
        { relationshipId: satisfiesId },
        ctx(member, { keyScope: { parts: ['read'] } }),
      ),
    ).rejects.toThrow(/Permission denied/)
    expect(
      (
        (await list.invoke(
          { designId },
          ctx(member, { keyScope: { parts: ['read'] } }),
        )) as { total: number }
      ).total,
    ).toBe(1)
  })
})
