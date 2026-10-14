// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * DialogService — storage for chat dialogs.
 *
 * A tool that has more to show than a chat message can hold stores the
 * payload here and returns only the descriptor; see `@cascadia/commons/ai/dialogs` for the
 * contract and `./builders.ts` for how the read tools assemble payloads.
 *
 * Rows belong to a chat session (cascade-deleted with it) and to the user who
 * was chatting. Reads always name the user, so a dialog id — which travels
 * through the model's context and the stored transcript — is never enough on
 * its own to read a payload.
 */

import { and, eq } from 'drizzle-orm'
import type { ToolContext } from '@/ai/tools/permission-wrapper'
import type {
  ChatDialog,
  ChatDialogDescriptor,
  ChatDialogKind,
  DialogPayloads,
} from '@cascadia/commons/ai/dialogs'
import { db } from '@/db'
import { aiChatDialogs } from '@/db/schema/ai'
import { takeFirst } from '@/db/take-first'

/** `title` column width. Model-authored titles are bounded below this. */
const TITLE_MAX_LENGTH = 200

/** What a tool hands over to be stored. */
export interface DialogSpec<TKind extends ChatDialogKind = ChatDialogKind> {
  kind: TKind
  title: string
  payload: DialogPayloads[TKind]
  /** Button text; the panel has a per-kind default. */
  label?: string
  /** Model-facing note carried in the descriptor. */
  summary?: string
}

export class DialogService {
  async create<TKind extends ChatDialogKind>(
    sessionId: string,
    userId: string,
    toolName: string,
    spec: DialogSpec<TKind>,
  ): Promise<ChatDialogDescriptor> {
    const row = takeFirst(
      await db
        .insert(aiChatDialogs)
        .values({
          sessionId,
          userId,
          toolName,
          kind: spec.kind,
          title: spec.title.slice(0, TITLE_MAX_LENGTH),
          payload: spec.payload,
        })
        .returning(),
    )
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      label: spec.label,
      summary: spec.summary,
    }
  }

  /**
   * One dialog, or null when it does not exist *or belongs to someone else* —
   * the two are deliberately indistinguishable to the caller.
   */
  async getForUser(id: string, userId: string): Promise<ChatDialog | null> {
    const row = await db.query.aiChatDialogs.findFirst({
      where: and(eq(aiChatDialogs.id, id), eq(aiChatDialogs.userId, userId)),
    })
    if (!row) return null
    // `kind` and `payload` are two columns, so the row cannot express that
    // they correlate; the insert above is the only writer and always stores
    // a payload of the row's kind.
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      toolName: row.toolName,
      createdAt: row.createdAt.toISOString(),
      payload: row.payload,
    } as ChatDialog
  }
}

export const dialogService = new DialogService()

/**
 * Whether a chat panel will render this call's result — the one condition
 * under which storing a dialog makes sense.
 *
 * Both halves are needed. The MCP surface has no session and no panel: the
 * agent gets the full tool result instead. The design engine runs the same
 * handlers *with* a chat session id, purely so its audit rows attribute to
 * the conversation that started it, and nothing renders those results
 * either — so a session alone is not enough, and the surface has to say so.
 */
export function chatPanelListening(context: ToolContext): boolean {
  return (
    Boolean(context.sessionId) &&
    (context.surface === 'chat' || context.surface === 'search')
  )
}

/**
 * Store a dialog for the calling chat session and return the descriptor the
 * tool result should carry, or undefined when no panel is listening.
 *
 * That one check is what keeps every dialog-producing tool identical across
 * surfaces: the tools do not know who called them, only whether a panel will
 * show a button.
 */
export async function presentDialog<TKind extends ChatDialogKind>(
  context: ToolContext,
  toolName: string,
  spec: DialogSpec<TKind>,
): Promise<ChatDialogDescriptor | undefined> {
  if (!context.sessionId || !chatPanelListening(context)) return undefined
  return dialogService.create(context.sessionId, context.userId, toolName, spec)
}
