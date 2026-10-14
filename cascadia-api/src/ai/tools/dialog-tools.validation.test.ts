// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `request_user_input` and `suggest_actions` input shaping.
 *
 * Security gate. Both tools store what the model sends and the chat panel
 * renders it: an action's `href` becomes a navigation the user triggers with
 * one click, and the model composes it after reading tool results — item
 * names and descriptions any user with write access authored. The invariant
 * these pin is the one `offer_navigation` holds: whatever the model asks for,
 * what gets stored addresses a route in this app or nothing at all.
 *
 * Also pinned: neither tool exists outside the in-app chat. On the MCP
 * surface they are not listed, and a handler invoked without a chat session
 * stores nothing.
 *
 * The hostile cases go through `toolRegistry[].invoke`, whose input is
 * `unknown` — the registry documents pre-validation as a caller convention,
 * and the point of these cases is that the handlers do not depend on it.
 *
 * Run: npx vitest run packages/core/src/lib/ai/tools/dialog-tools.validation.test.ts
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
import { toolRegistry, toolsForSurface } from './registry'
import type { ToolContext } from './permission-wrapper'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { ChatDialogDescriptor } from '@cascadia/commons/ai/dialogs'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { dialogService } from '@/ai/dialogs/DialogService'
import { sessionService } from '@/ai/SessionService'
import { permissionService } from '@/auth/permission-service'
import { aiChatDialogs } from '@/db/schema/ai'
import { ValidationError } from '@/errors'

interface DialogToolResult {
  dialog?: ChatDialogDescriptor
  displayed: boolean
  error?: string
}

describe('dialog tools — model-authored dialog inputs', () => {
  const testDb = new TestDatabase()

  let user: TestUser
  let context: ToolContext

  const entry = (name: string) => {
    const found = toolRegistry.find((tool) => tool.name === name)
    if (!found) throw new Error(`Tool ${name} is not registered`)
    return found
  }
  const suggestActions = (input: unknown, ctx: ToolContext = context) =>
    entry('suggest_actions').invoke(input, ctx) as Promise<DialogToolResult>
  const requestUserInput = (input: unknown, ctx: ToolContext = context) =>
    entry('request_user_input').invoke(input, ctx) as Promise<DialogToolResult>

  const storedDialogs = () =>
    testDb.db
      .select({ id: aiChatDialogs.id })
      .from(aiChatDialogs)
      .where(eq(aiChatDialogs.userId, user.id))

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
      createCustomTestRole(`AI Dialog Tools ${randomUUID().slice(0, 8)}`, {
        parts: ['read'],
      }),
    )
    user = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, user.id, role.id)
    permissionService.clearCache()

    const chatSession = await sessionService.createSession(user.id)
    context = { userId: user.id, sessionId: chatSession.id, surface: 'chat' }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  // ── suggest_actions: href egress ──────────────────────────────────────

  it.each([
    'https://exfil.example/collect?d=secret',
    '//exfil.example/collect',
    '/\\exfil.example',
    'javascript:alert(1)',
    'tools/new',
    '/tools/new with spaces',
  ])(
    'refuses an action href that is not an app-relative path: %s',
    async (href) => {
      await expect(
        suggestActions({
          title: 'Manage tools',
          actions: [{ label: 'Open', href }],
        }),
      ).rejects.toThrow(ValidationError)

      expect(await storedDialogs()).toHaveLength(0)
    },
  )

  it('stores an app-relative href and hands back a descriptor', async () => {
    const result = await suggestActions({
      title: 'Manage tools',
      description: 'Two machines need attention',
      actions: [
        { label: 'Add a tool', href: '/tools/new' },
        {
          label: 'Review the CNC mill',
          message: 'Show me the maintenance history of the CNC mill',
        },
      ],
      inputs: [
        {
          label: 'Product page',
          messageTemplate: 'Create a new tool from this page: {value}',
        },
      ],
    })

    expect(result.displayed).toBe(true)
    expect(result.dialog).toMatchObject({
      kind: 'actions',
      title: 'Manage tools',
    })

    const stored = await dialogService.getForUser(result.dialog!.id, user.id)
    expect(stored?.kind).toBe('actions')
    expect(stored?.payload).toMatchObject({
      actions: [{ href: '/tools/new' }, { message: expect.any(String) }],
    })
  })

  it('refuses an action that neither sends a message nor opens a page', async () => {
    await expect(
      suggestActions({
        title: 'Manage tools',
        actions: [{ label: 'Does nothing' }],
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('refuses an input whose template has nowhere to put the value', async () => {
    await expect(
      suggestActions({
        title: 'Manage tools',
        actions: [],
        inputs: [{ label: 'Link', messageTemplate: 'Create a tool' }],
      }),
    ).rejects.toThrow(ValidationError)
  })

  // ── request_user_input: form shape ────────────────────────────────────

  it('refuses a select with nothing to select from', async () => {
    await expect(
      requestUserInput({
        title: 'New Part',
        fields: [{ name: 'partType', label: 'Part type', type: 'select' }],
      }),
    ).rejects.toThrow(ValidationError)

    expect(await storedDialogs()).toHaveLength(0)
  })

  it('stores a valid form with the schema defaults applied', async () => {
    const result = await requestUserInput({
      title: 'New Part',
      fields: [
        { name: 'name', label: 'Name', required: true },
        {
          name: 'design',
          label: 'Design',
          type: 'select',
          optionsFrom: 'designs',
        },
      ],
    })

    expect(result.displayed).toBe(true)
    const stored = await dialogService.getForUser(result.dialog!.id, user.id)
    expect(stored?.kind).toBe('form')
    expect(stored?.payload).toMatchObject({
      fields: [
        { name: 'name', type: 'text' },
        { name: 'design', type: 'select', optionsFrom: 'designs' },
      ],
    })
  })

  // ── surfaces ──────────────────────────────────────────────────────────

  it.each([
    ['an MCP-shaped context', (): ToolContext => ({ userId: user.id })],
    // The design engine runs the same handlers with a chat session id, for
    // audit attribution only — nothing renders those results.
    [
      'a session with no chat surface',
      (): ToolContext => ({ userId: user.id, sessionId: context.sessionId }),
    ],
  ])('stores nothing for %s', async (_label, makeContext) => {
    const result = await requestUserInput(
      { title: 'New Part', fields: [{ name: 'name', label: 'Name' }] },
      makeContext(),
    )

    expect(result.displayed).toBe(false)
    expect(result.dialog).toBeUndefined()
    expect(await storedDialogs()).toHaveLength(0)
  })

  it('is exposed to the in-app chat only', () => {
    const names = (surface: Parameters<typeof toolsForSurface>[0]) =>
      toolsForSurface(surface).map((tool) => tool.name)

    expect(names('chat')).toEqual(
      expect.arrayContaining(['request_user_input', 'suggest_actions']),
    )
    expect(names('mcp')).not.toContain('request_user_input')
    expect(names('mcp')).not.toContain('suggest_actions')
    expect(names('search')).not.toContain('request_user_input')
    expect(names('search')).not.toContain('suggest_actions')
  })
})
