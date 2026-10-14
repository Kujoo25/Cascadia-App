// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type { UIMessage } from '@tanstack/ai-react'
import type { ChatDialog } from '@cascadia/commons/ai/dialogs'
import { apiFetch } from '@/api/client'

/** One row of the chat sidebar's conversation history. */
export interface AiChatSession {
  id: string
  title: string | null
  createdAt: string
  updatedAt: string
}

/**
 * A persisted turn, as `/ai/sessions/:id/messages` hands it back.
 *
 * `arguments` is whatever landed in the jsonb column: an object for a call
 * the server assembled itself, a string for one persisted verbatim from a
 * provider. Both shapes are real, and the UI wants the string form.
 */
interface PersistedChatMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls: Array<{
    id: string
    name: string
    arguments: string | Record<string, unknown>
  }> | null
  /** On a `tool` row: the call this row is the result of. */
  toolCallId: string | null
  createdAt: string
}

type ChatMessagePart = UIMessage['parts'][number]

/**
 * A write tool's preview, which the live stream rendered as a Confirm/Cancel
 * card. Not restored: its token expired minutes after it was minted, and the
 * transcript's next user turn already records what was chosen.
 */
function isConfirmationPreview(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { requiresConfirmation?: unknown }).requiresConfirmation ===
        true
    )
  } catch {
    return false
  }
}

/**
 * Rebuild the on-screen transcript from the persisted one.
 *
 * System prompts are dropped. A tool call is restored as the
 * `input-complete` part the streamed message would have carried, and its
 * result row is restored onto the same turn as a `tool-result` part — which
 * is what lets a reopened conversation still show the navigation buttons and
 * dialog buttons it showed live. Confirmation previews are the one result
 * left out; see `isConfirmationPreview`.
 */
function toUiMessages(messages: Array<PersistedChatMessage>): Array<UIMessage> {
  const uiMessages: Array<UIMessage> = []
  // Tool-call id → the assistant turn that made the call, so its result can
  // be attached to that turn when the tool row comes past.
  const callers = new Map<string, UIMessage>()

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'tool') {
      const caller = message.toolCallId
        ? callers.get(message.toolCallId)
        : undefined
      if (
        caller &&
        message.toolCallId &&
        !isConfirmationPreview(message.content)
      ) {
        caller.parts.push({
          type: 'tool-result',
          toolCallId: message.toolCallId,
          content: message.content,
          state: 'complete',
        })
      }
      continue
    }

    const parts: Array<ChatMessagePart> = []

    if (message.content) {
      parts.push({ type: 'text', content: message.content })
    }

    for (const toolCall of message.toolCalls ?? []) {
      parts.push({
        type: 'tool-call',
        id: toolCall.id,
        name: toolCall.name,
        arguments:
          typeof toolCall.arguments === 'string'
            ? toolCall.arguments
            : JSON.stringify(toolCall.arguments),
        state: 'input-complete',
      })
    }

    // A turn with neither text nor tool calls still has to render as
    // something.
    if (parts.length === 0) {
      parts.push({ type: 'text', content: '' })
    }

    const uiMessage: UIMessage = {
      id: message.id,
      role: message.role,
      parts,
      createdAt: new Date(message.createdAt),
    }
    for (const toolCall of message.toolCalls ?? []) {
      callers.set(toolCall.id, uiMessage)
    }
    uiMessages.push(uiMessage)
  }

  return uiMessages
}

/**
 * Every chat session the signed-in user owns, newest first.
 *
 * Titles are generated server-side from the first message, so the list has
 * to restage once a response completes — the panel does that by invalidating
 * `'ai'` rather than refetching by hand. Pass `enabled: false` while the
 * panel is closed; reopening it inside the cache window then costs nothing.
 */
export function aiSessionsQuery(enabled = true) {
  return queryOptions({
    queryKey: qk.collection('ai', 'sessions'),
    queryFn: async (): Promise<Array<AiChatSession>> => {
      const result = await apiFetch<{
        data: { sessions: Array<AiChatSession> }
      }>('/api/v1/ai/sessions')
      return result.data.sessions
    },
    enabled,
  })
}

/**
 * One session's transcript, already in the shape `useChat` renders.
 *
 * The conversion lives in the queryFn so the cache holds UI messages
 * directly: the panel hydrates `setMessages` from this when the selected
 * session changes, and re-deriving on every read would be one more place for
 * the persisted and on-screen shapes to drift.
 */
export function aiSessionMessagesQuery(
  sessionId: string | undefined,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.sub('ai', sessionId ?? '', 'messages'),
    queryFn: async (): Promise<Array<UIMessage>> => {
      const result = await apiFetch<{
        data: { messages: Array<PersistedChatMessage> }
      }>(`/api/v1/ai/sessions/${sessionId ?? ''}/messages`)
      return toUiMessages(result.data.messages)
    },
    enabled: enabled && Boolean(sessionId),
  })
}

/**
 * The payload behind one dialog button — a result grid, a graph, a form, or
 * suggested actions. Fetched when the button is clicked, never with the
 * transcript: the tool result only carries the descriptor. A stored dialog
 * never changes, so it is kept fresh for as long as it is cached.
 */
export function aiDialogQuery(dialogId: string | undefined) {
  return queryOptions({
    queryKey: qk.collection('ai', 'dialogs', dialogId ?? ''),
    queryFn: async (): Promise<ChatDialog> => {
      const result = await apiFetch<{ data: { dialog: ChatDialog } }>(
        `/api/v1/ai/dialogs/${encodeURIComponent(dialogId ?? '')}`,
      )
      return result.data.dialog
    },
    enabled: Boolean(dialogId),
    staleTime: Infinity,
  })
}
