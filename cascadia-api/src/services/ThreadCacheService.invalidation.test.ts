// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Which cached threads an item write invalidates.
 *
 * A thread is read through the version lineage, so an entry is stale the
 * moment any row of a master it contains is written — and a `released`
 * thread reads main's head, which every release moves. Pinned here: the
 * live, branch and released entries of a master's lineage go, the tag and
 * commit snapshots stay.
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
import { eq } from 'drizzle-orm'
import { ThreadCacheService } from './ThreadCacheService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { items, threadPathCache } from '@/db/schema'
import { takeFirst } from '@/db/take-first'

describe('ThreadCacheService.invalidateForItems', () => {
  const testDb = new TestDatabase()
  let user: TestUser

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function insertItem(masterId: string, revision: string) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    return takeFirst(
      await testDb.db
        .insert(items)
        .values({
          masterId,
          itemNumber: `CACHE-${suffix}`,
          revision,
          itemType: 'Part',
          state: 'Draft',
          isCurrent: revision === 'B',
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning({ id: items.id }),
    ).id
  }

  async function insertEntry(
    rootItemId: string,
    includedItemIds: Array<string>,
    context: { contextType: string | null; contextId: string | null },
  ) {
    return takeFirst(
      await testDb.db
        .insert(threadPathCache)
        .values({
          rootItemId,
          cacheConfigHash: `hash-${Math.random().toString(36).slice(2, 10)}`,
          threadData: {},
          includedItemIds,
          contextType: context.contextType,
          contextId: context.contextId,
        })
        .returning({ id: threadPathCache.id }),
    ).id
  }

  async function invalidatedAt(id: string) {
    const [row] = await testDb.db
      .select({ invalidatedAt: threadPathCache.invalidatedAt })
      .from(threadPathCache)
      .where(eq(threadPathCache.id, id))
    return row?.invalidatedAt ?? null
  }

  it('invalidates the live, branch and released entries of the lineage, and keeps the snapshots', async () => {
    const masterId = randomUUID()
    const revA = await insertItem(masterId, 'A')
    const revB = await insertItem(masterId, 'B')
    const unrelated = await insertItem(randomUUID(), 'B')

    const live = await insertEntry(revB, [revB], {
      contextType: null,
      contextId: null,
    })
    const branch = await insertEntry(revB, [revB], {
      contextType: 'branch',
      contextId: randomUUID(),
    })
    const released = await insertEntry(revB, [revB], {
      contextType: 'released',
      contextId: null,
    })
    const tag = await insertEntry(revB, [revB], {
      contextType: 'tag',
      contextId: randomUUID(),
    })
    const commit = await insertEntry(revB, [revB], {
      contextType: 'commit',
      contextId: randomUUID(),
    })
    const elsewhere = await insertEntry(unrelated, [unrelated], {
      contextType: null,
      contextId: null,
    })

    // Written against the row a release superseded — the shape every edge
    // naming an earlier revision has — and the current row's threads go.
    await ThreadCacheService.invalidateForItems([revA])

    expect(await invalidatedAt(live)).not.toBeNull()
    expect(await invalidatedAt(branch)).not.toBeNull()
    expect(await invalidatedAt(released)).not.toBeNull()
    expect(await invalidatedAt(tag)).toBeNull()
    expect(await invalidatedAt(commit)).toBeNull()
    expect(await invalidatedAt(elsewhere)).toBeNull()
  })
})
