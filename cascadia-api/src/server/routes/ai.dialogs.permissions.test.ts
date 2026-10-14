// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Chat dialogs — ownership at the HTTP edge
 *
 * Security gate. A dialog's payload is the full result set of a tool call:
 * every search hit, a whole BOM, the where-used tree above an item. Its id
 * is not a secret — it rides in the model's context and in the stored
 * transcript — so `GET /api/ai/dialogs/:id` must answer to the user who was
 * chatting and to nobody else, and must not tell an outsider whether the id
 * exists at all.
 *
 * Run: npx vitest run packages/core/src/server/routes/ai.dialogs.permissions.test.ts
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
import aiRoutes from './ai'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { ChatDialog } from '@cascadia/commons/ai/dialogs'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { dialogService } from '@/ai/dialogs/DialogService'
import { sessionService } from '@/ai/SessionService'
import { SessionManager } from '@/auth/session'
import { permissionService } from '@/auth/permission-service'
import { aiChatDialogs } from '@/db/schema/ai'

describe('AI dialog routes — ownership', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/ai', aiRoutes)

  let owner: TestUser
  let outsider: TestUser
  let chatSessionId: string
  let dialogId: string

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

    const role = await insertTestRole(
      testDb.db,
      createCustomTestRole(`AI Dialogs ${randomUUID().slice(0, 8)}`, {
        parts: ['read'],
      }),
    )
    owner = await insertTestUser(testDb.db)
    outsider = await insertTestUser(testDb.db)
    for (const u of [owner, outsider]) {
      await assignRoleToUser(testDb.db, u.id, role.id)
    }
    permissionService.clearCache()

    const chatSession = await sessionService.createSession(owner.id)
    chatSessionId = chatSession.id
    const descriptor = await dialogService.create(
      chatSessionId,
      owner.id,
      'search_items',
      {
        kind: 'data-grid',
        title: 'Parts matching "bracket"',
        payload: {
          columns: [{ id: 'itemNumber', header: 'Number', type: 'link' }],
          rows: [{ itemNumber: 'P-1001', href: '/parts/abc' }],
          total: 1,
          truncated: false,
        },
      },
    )
    dialogId = descriptor.id

    cookies.clear()
    for (const u of [owner, outsider]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function get(user: TestUser, path: string) {
    return app.request(path, {
      method: 'GET',
      headers: { Cookie: cookies.get(user.id)!, Origin: 'http://localhost' },
    })
  }

  it('serves the owner their dialog with its payload', async () => {
    const response = await get(owner, `/api/ai/dialogs/${dialogId}`)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { dialog: ChatDialog } }
    expect(body.data.dialog.kind).toBe('data-grid')
    expect(body.data.dialog.title).toBe('Parts matching "bracket"')
    expect(body.data.dialog.payload).toMatchObject({
      rows: [{ itemNumber: 'P-1001' }],
    })
  })

  it('answers an outsider with the same not-found a missing id gets', async () => {
    const foreign = await get(outsider, `/api/ai/dialogs/${dialogId}`)
    const missing = await get(outsider, `/api/ai/dialogs/${randomUUID()}`)

    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    // Nothing in the body distinguishes "yours, but not readable" from
    // "does not exist" — the payload's shape and title stay with the owner.
    expect(await foreign.text()).not.toContain('bracket')
  })

  it('treats an id that is not a UUID as not found rather than a query error', async () => {
    const response = await get(owner, '/api/ai/dialogs/not-a-uuid')

    expect(response.status).toBe(404)
  })

  it('refuses an unauthenticated read', async () => {
    const response = await app.request(`/api/ai/dialogs/${dialogId}`)

    expect(response.status).toBe(401)
  })

  it('deletes the dialogs with their session', async () => {
    await sessionService.deleteSession(chatSessionId)

    const rows = await testDb.db
      .select({ id: aiChatDialogs.id })
      .from(aiChatDialogs)
      .where(eq(aiChatDialogs.id, dialogId))
    expect(rows).toHaveLength(0)
    expect(await dialogService.getForUser(dialogId, owner.id)).toBeNull()
  })
})
