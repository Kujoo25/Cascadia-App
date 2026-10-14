// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Dialog tool definitions — the two chat-only tools through which the model
 * asks for a dialog of its own: a form to collect details, or a menu of
 * suggested next steps. The server-built dialogs (result grids, graphs) need
 * no tool; the read tools attach those themselves.
 *
 * Both input schemas are the stored payload schema plus a title, so what the
 * model is allowed to send and what the browser is allowed to render are the
 * same definition (`@cascadia/commons/ai/dialogs`).
 */

import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'
import {
  actionsDialogPayloadSchema,
  dialogDescriptorSchema,
  formDialogPayloadSchema,
} from '@cascadia/commons/ai/dialogs'

const dialogToolOutputSchema = z.object({
  dialog: dialogDescriptorSchema.optional(),
  displayed: z
    .boolean()
    .describe('Whether the chat panel is showing the dialog button'),
  error: z.string().optional(),
})

const titleSchema = z
  .string()
  .min(1)
  .max(120)
  .describe('Dialog title, e.g. "New Part" or "Manage tools"')

// ============================================================================
// request_user_input - collect details through a form dialog
// ============================================================================

export const requestUserInputInputSchema = formDialogPayloadSchema.extend({
  title: titleSchema,
})
export type RequestUserInputInput = z.input<typeof requestUserInputInputSchema>

export const requestUserInputDef = toolDefinition({
  name: 'request_user_input',
  description: `Ask the user for structured details through a form dialog instead of a back-and-forth in chat.
Use it when an action needs several values you do not have yet — creating a Part, Design, Program or ECO, recording a tool's capabilities, choosing between options.
The chat panel shows a "Fill in details" button. When the user submits, their answers arrive as their next message ("Submitted form …", one field per line); then carry on and call the write tool with those values — its own confirmation step still applies.
Keep it to the fields you actually need. Use "select" with explicit options when the choices are known (item types, part types, priorities); use optionsFrom "designs" or "programs" for a design or program picker — the submitted value is the id.
Do not call this when the user already gave you everything, and do not repeat the questions in your message — the form asks them.`,
  inputSchema: requestUserInputInputSchema,
  outputSchema: dialogToolOutputSchema,
})

// ============================================================================
// suggest_actions - offer next steps as clickable actions
// ============================================================================

export const suggestActionsInputSchema = actionsDialogPayloadSchema.extend({
  title: titleSchema,
})
export type SuggestActionsInput = z.input<typeof suggestActionsInputSchema>

export const suggestActionsDef = toolDefinition({
  name: 'suggest_actions',
  description: `Offer the user a set of next steps as clickable actions in a dialog.
Use it for open-ended requests such as "let's manage our tools" or "what should I do about this ECO": look the data up first, then propose specific actions for what you found. Each action either sends a chat message on the user's behalf (message — word it as a request you can act on directly, naming the item) or opens a page in the app (href, an app-relative path such as /tools/new; never an external URL).
Add an input box when a typed value would unlock an action — for example a product page link to create a tool from; the box's messageTemplate is sent with {value} replaced by what the user typed.
The chat panel shows a "See suggested actions" button; a clicked action arrives as the user's next message.`,
  inputSchema: suggestActionsInputSchema,
  outputSchema: dialogToolOutputSchema,
})

export const allDialogToolDefinitions = [requestUserInputDef, suggestActionsDef]
