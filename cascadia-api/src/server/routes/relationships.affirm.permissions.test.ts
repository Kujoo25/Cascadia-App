// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Bulk affirm — the per-row gates
 *
 * Security gate. `POST /relationships/affirm` takes up to 500 edge ids and
 * answers per row, so the gates the single-link route applies — `update` on
 * the source item's own type, and access to both ends — have to hold for
 * every row rather than for the request as a whole, and a refusal has to be
 * reported rather than swallowed into a 403 for the batch.
 *
 * Three users: a WRITER who owns the program, a READER in the same program
 * with every read grant but no `update`, and a STRANGER with the writer's
 * grants but no membership. Each leg isolates one gate.
 *
 * Run: npx vitest run cascadia-api/src/server/routes/relationships.affirm.permissions.test.ts
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
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import relationshipsRoutes from './relationships'
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
import { affirmationOf } from '@/items/trace-affirmation'
import { DesignService } from '@/services/DesignService'
import { ProgramService } from '@/services/ProgramService'
import { RequirementService } from '@/services/RequirementService'
import { SessionManager } from '@/auth/session'
import { permissionService } from '@/auth/permission-service'
import { itemRelationships, programMembers } from '@/db/schema'

// Import to register item types
import '@/items/registerItemTypes.server'

interface BulkAffirmEnvelope {
  data: {
    affirmed: number
    results: Array<{ relationshipId: string; outcome: string }>
  }
}

describe('POST /relationships/affirm — per-row gates', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/relationships', relationshipsRoutes)

  let reader: TestUser
  let writer: TestUser
  let stranger: TestUser
  let satisfiesId: string
  let bomId: string

  const cookies = new Map<string, string>()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    const suffix = randomUUID().slice(0, 8)
    const readerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Affirm Reader ${suffix}`, {
        parts: ['read'],
        requirements: ['read'],
        programs: ['read'],
      }),
    )
    const writerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Affirm Writer ${suffix}`, {
        parts: ['create', 'read', 'update'],
        requirements: ['create', 'read', 'update'],
        designs: ['create', 'read'],
        programs: ['read'],
      }),
    )

    reader = await insertTestUser(testDb.db)
    writer = await insertTestUser(testDb.db)
    stranger = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, reader.id, readerRole.id)
    await assignRoleToUser(testDb.db, writer.id, writerRole.id)
    // Same grants as the writer; the only difference is membership.
    await assignRoleToUser(testDb.db, stranger.id, writerRole.id)
    permissionService.clearCache()

    const program = await ProgramService.create(
      {
        name: 'Affirm Program',
        code: `AFF-${Date.now()}-${suffix.slice(0, 4).toUpperCase()}`,
      },
      writer.id,
    )
    await testDb.db.insert(programMembers).values({
      programId: program.id,
      userId: reader.id,
      role: 'engineer',
    })
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Affirm Design',
        code: `AFFD-${Date.now()}`,
        designType: 'Engineering',
      },
      writer.id,
    )

    const part = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId: design.id,
        revision: 'A',
        name: 'Battery tray',
        partType: 'Manufacture',
      },
      writer.id,
    )
    const child = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId: design.id,
        revision: 'A',
        name: 'Tray bracket',
        partType: 'Manufacture',
      },
      writer.id,
    )
    const requirement = await ItemService.create<Requirement>(
      'Requirement',
      {
        itemType: 'Requirement',
        designId: design.id,
        revision: 'A',
        name: 'The cart shall carry 24 V packs',
      },
      writer.id,
    )
    await RequirementService.linkSatisfaction(
      requirement.id!,
      [part.id!],
      writer.id,
    )
    await ItemService.addRelationship(part.id!, child.id!, 'BOM', writer.id, {
      quantity: '2',
    })
    satisfiesId = (await edgeOf(part.id!, 'SATISFIES')).id
    bomId = (await edgeOf(part.id!, 'BOM')).id

    cookies.clear()
    for (const u of [reader, writer, stranger]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function edgeOf(sourceId: string, relationshipType: string) {
    const [edge] = await testDb.db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, sourceId),
          eq(itemRelationships.relationshipType, relationshipType),
        ),
      )
      .limit(1)
    return edge!
  }

  async function affirm(
    user: TestUser,
    relationshipIds: Array<string>,
  ): Promise<Response> {
    return app.request('/api/v1/relationships/affirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies.get(user.id)!,
        Origin: 'http://localhost',
      },
      body: JSON.stringify({ relationshipIds }),
    })
  }

  async function affirmedBy(relationshipId: string): Promise<string | null> {
    const [edge] = await testDb.db
      .select({ metadata: itemRelationships.metadata })
      .from(itemRelationships)
      .where(eq(itemRelationships.id, relationshipId))
    return affirmationOf(edge?.metadata)?.affirmedBy ?? null
  }

  it('affirms for a member holding update on the source type, and reports the rows it could not', async () => {
    const missing = randomUUID()
    const response = await affirm(writer, [satisfiesId, bomId, missing])

    expect(response.status).toBe(200)
    const { data } = (await response.json()) as BulkAffirmEnvelope
    expect(data.affirmed).toBe(1)
    expect(data.results).toEqual([
      expect.objectContaining({
        relationshipId: satisfiesId,
        outcome: 'affirmed',
        suspect: false,
      }),
      { relationshipId: bomId, outcome: 'not_suspectable' },
      { relationshipId: missing, outcome: 'not_found' },
    ])
    expect(await affirmedBy(satisfiesId)).toBe(writer.id)
  })

  it('refuses a read-only member every row, writing nothing', async () => {
    const response = await affirm(reader, [satisfiesId])

    expect(response.status).toBe(200)
    const { data } = (await response.json()) as BulkAffirmEnvelope
    expect(data).toEqual({
      affirmed: 0,
      results: [{ relationshipId: satisfiesId, outcome: 'forbidden' }],
    })
    expect(await affirmedBy(satisfiesId)).toBe(writer.id)
  })

  it('refuses a non-member holding the grant, writing nothing', async () => {
    const response = await affirm(stranger, [satisfiesId])

    expect(response.status).toBe(200)
    const { data } = (await response.json()) as BulkAffirmEnvelope
    expect(data).toEqual({
      affirmed: 0,
      results: [{ relationshipId: satisfiesId, outcome: 'forbidden' }],
    })
    expect(await affirmedBy(satisfiesId)).toBe(writer.id)
  })
})
