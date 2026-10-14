// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Part validation routes — RBAC gate
 *
 * Security gate. `POST`/`DELETE /parts/:id/validate` and
 * `GET /parts/:id/validating-tests` declared no `permission` tuple, so
 * `apiHandler` skipped the RBAC block: role permissions were never consulted
 * and a scoped API key had nothing to intersect against. Program membership
 * was the only gate, which meant a read-only member could rewire any part's
 * validation links. The same hole the requirement traceability routes had,
 * one edge type over.
 *
 * Both users are members of the same program and hold the same item-reaching
 * grants. The ONLY difference is `parts:update`, so a 403 can come from
 * nothing but the tuple. The writer's legs assert "anything but 403": the
 * permission check runs ahead of the body and the service, so a downstream
 * 400/404/409 still proves the gate admitted the caller.
 *
 * Run: npx vitest run cascadia-api/src/server/routes/parts.validate.permissions.test.ts
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
import { ErrorCode } from '@cascadia/commons/errors/codes'
import partsRoutes from './parts'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@cascadia/commons/items/types/part'
import type { TestCase } from '@cascadia/commons/items/types/testcase'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { ItemService } from '@/items/services/ItemService'
import { DesignService } from '@/services/DesignService'
import { ProgramService } from '@/services/ProgramService'
import { SessionManager } from '@/auth/session'
import { permissionService } from '@/auth/permission-service'
import { programMembers } from '@/db/schema'

// Import to register item types
import '@/items/registerItemTypes.server'

interface ErrorEnvelope {
  error: { code: string }
}

describe('part validation routes — RBAC gate', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/parts', partsRoutes)

  let reader: TestUser
  let writer: TestUser
  let stranger: TestUser
  let partId: string
  let testCaseId: string

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

    // READER is the shape of the stock 'View Only' role on parts. WRITER
    // differs by exactly one grant. Neither holds programs:manage.
    const readerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Validate Reader ${suffix}`, {
        parts: ['read'],
        test_cases: ['read'],
        programs: ['read'],
      }),
    )
    const writerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Validate Writer ${suffix}`, {
        parts: ['create', 'read', 'update'],
        test_cases: ['create', 'read', 'update'],
        designs: ['create', 'read'],
        programs: ['read'],
      }),
    )
    // Reads everything the fixture touches EXCEPT parts, so the read leg
    // isolates the parts tuple.
    const strangerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Validate Stranger ${suffix}`, {
        test_cases: ['read'],
        documents: ['read'],
        programs: ['read'],
      }),
    )

    reader = await insertTestUser(testDb.db)
    writer = await insertTestUser(testDb.db)
    stranger = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, reader.id, readerRole.id)
    await assignRoleToUser(testDb.db, writer.id, writerRole.id)
    await assignRoleToUser(testDb.db, stranger.id, strangerRole.id)
    permissionService.clearCache()

    const program = await ProgramService.create(
      {
        name: 'Validate Program',
        code: `VAL-${Date.now()}-${suffix.slice(0, 4).toUpperCase()}`,
      },
      writer.id,
    )
    await testDb.db.insert(programMembers).values(
      [reader, stranger].map((u) => ({
        programId: program.id,
        userId: u.id,
        role: 'engineer',
      })),
    )

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Validate Design',
        code: `VALD-${Date.now()}`,
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
        name: 'Lift Actuator',
        partType: 'Manufacture',
      },
      writer.id,
    )
    partId = part.id!

    const testCase = await ItemService.create<TestCase>(
      'TestCase',
      {
        itemType: 'TestCase',
        designId: design.id,
        revision: 'A',
        name: 'Static load test',
      },
      writer.id,
    )
    testCaseId = testCase.id!

    cookies.clear()
    for (const u of [reader, writer, stranger]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function call(
    user: TestUser,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`/api/v1/parts${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies.get(user.id)!,
        Origin: 'http://localhost',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  function writes(): Array<{
    name: string
    send: (user: TestUser) => Promise<Response>
  }> {
    return [
      {
        name: 'POST /:id/validate',
        send: (u) =>
          call(u, 'POST', `/${partId}/validate`, { testCaseIds: [testCaseId] }),
      },
      {
        name: 'DELETE /:id/validate',
        send: (u) =>
          call(u, 'DELETE', `/${partId}/validate?testCaseId=${testCaseId}`),
      },
    ]
  }

  describe('writes require parts:update', () => {
    it('refuses a read-only member both validation writes', async () => {
      for (const { name, send } of writes()) {
        const response = await send(reader)

        expect(response.status, name).toBe(403)
        const payload = (await response.json()) as ErrorEnvelope
        expect(payload.error.code, name).toBe(ErrorCode.PERMISSION_DENIED)
      }
    })

    it('admits a member holding parts:update to both', async () => {
      for (const { name, send } of writes()) {
        const response = await send(writer)

        expect(response.status, name).not.toBe(403)
      }
    })
  })

  describe('the read requires parts:read', () => {
    it('refuses a member with every other read grant but not parts', async () => {
      const response = await call(
        stranger,
        'GET',
        `/${partId}/validating-tests`,
      )

      expect(response.status).toBe(403)
      const payload = (await response.json()) as ErrorEnvelope
      expect(payload.error.code).toBe(ErrorCode.PERMISSION_DENIED)
    })

    it('admits a member holding parts:read', async () => {
      const response = await call(reader, 'GET', `/${partId}/validating-tests`)

      expect(response.status).toBe(200)
    })
  })
})
