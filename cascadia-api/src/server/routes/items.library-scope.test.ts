// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `designScope=library` searches every library, not only STD-LIB
 *
 * The BOM pickers ask for candidates with `designScope=library`, and the
 * server accepts a BOM target in any `Library` design
 * (`ItemRelationshipService.assertBomTargetScope`). The scope used to resolve
 * to the Standard Library alone, so a part in a user-created library — an
 * electrical-components library kept apart from STD-LIB's fasteners — could
 * never be offered, although the write would have succeeded
 * (Cascadia-App#99).
 *
 * Pinned here:
 *
 *  - both search paths (`q=` and `itemType=`) return parts from every
 *    library, the Standard Library and user-created ones alike
 *  - an archived library is not searched
 *  - a non-library design is not searched
 *  - widening the scope does not widen access: a library inside a program
 *    the caller is not a member of contributes nothing
 *
 * Run: npx vitest run cascadia-api/src/server/routes/items.library-scope.test.ts
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
import { eq } from 'drizzle-orm'
import itemsRoutes from './items'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { ItemService } from '@/items/services/ItemService'
import { DesignService } from '@/services/DesignService'
import { SessionManager } from '@/auth/session'
import { permissionService } from '@/auth/permission-service'
import { designs, programs } from '@/db/schema'
import { takeFirst } from '@/db/take-first'

// Import to register item types
import '@/items/registerItemTypes.server'

interface SearchBody {
  data: { items: Array<{ id: string }> }
}

describe('items search — designScope=library', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/items', itemsRoutes)

  let user: TestUser
  let cookie: string
  // One nonce per test, in every part's name, so a search matches only this
  // test's parts and never another run's.
  let nonce: string

  let firstLibraryPart: string
  let secondLibraryPart: string
  let archivedLibraryPart: string
  let engineeringPart: string
  let otherProgramLibraryPart: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    // A plain `User`: reads parts, holds no cross-program authority, and is a
    // member of no program, so program-less designs are all it can read.
    user = (await insertTestUserWithRole(testDb.db, 'User')).user
    cookie = `session=${(await SessionManager.createSession(user.id)).sessionToken}`
    nonce = randomUUID().slice(0, 8).toUpperCase()

    const firstLibrary = await createDesign('Library', null)
    const secondLibrary = await createDesign('Library', null)
    const archivedLibrary = await createDesign('Library', null)
    const engineering = await createDesign('Engineering', null)

    const otherProgram = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Someone Else’s Program',
          code: `PROG-${nonce}`,
          createdBy: user.id,
        })
        .returning(),
    )
    const otherProgramLibrary = await createDesign('Library', otherProgram.id)

    firstLibraryPart = await createPart(firstLibrary, 'first')
    secondLibraryPart = await createPart(secondLibrary, 'second')
    archivedLibraryPart = await createPart(archivedLibrary, 'archived')
    engineeringPart = await createPart(engineering, 'engineering')
    otherProgramLibraryPart = await createPart(otherProgramLibrary, 'other')

    // Directly, because DesignService.archive() refuses every Library design.
    await testDb.db
      .update(designs)
      .set({ isArchived: true })
      .where(eq(designs.id, archivedLibrary))
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createDesign(
    designType: 'Library' | 'Engineering',
    programId: string | null,
  ): Promise<string> {
    const design = await DesignService.create(
      {
        programId,
        name: `${designType} ${randomUUID().slice(0, 8)}`,
        code: `LS-${randomUUID().slice(0, 8).toUpperCase()}`,
        designType,
      },
      user.id,
    )
    return design.id
  }

  async function createPart(designId: string, label: string): Promise<string> {
    const part: { id: string } = await ItemService.create(
      'Part',
      {
        designId,
        itemNumber: `LS-${nonce}-${label.toUpperCase()}`,
        revision: 'A',
        name: `Library scope ${nonce} ${label}`,
        partType: 'Purchase',
      } as never,
      user.id,
    )
    return part.id
  }

  async function search(query: string): Promise<Set<string>> {
    const res = await app.request(`/api/v1/items/search?${query}`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SearchBody
    return new Set(body.data.items.map((item) => item.id))
  }

  for (const [label, query] of [
    ['text search (q=)', () => `q=LS-${nonce}&designScope=library&limit=50`],
    [
      'structured search (itemType=)',
      () => `itemType=Part&designScope=library&limit=500`,
    ],
  ] as const) {
    describe(label, () => {
      it('returns parts from every library, not only STD-LIB', async () => {
        const ids = await search(query())

        expect(ids).toContain(firstLibraryPart)
        expect(ids).toContain(secondLibraryPart)
      })

      it('leaves out archived libraries and non-library designs', async () => {
        const ids = await search(query())

        expect(ids).not.toContain(archivedLibraryPart)
        expect(ids).not.toContain(engineeringPart)
      })

      it('does not reach a library in a program the caller is not in', async () => {
        const ids = await search(query())

        expect(ids).not.toContain(otherProgramLibraryPart)
      })
    })
  }
})
