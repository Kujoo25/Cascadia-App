// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Dialog tool handlers: `request_user_input` and `suggest_actions`.
 *
 * Both store a model-authored dialog and hand back its descriptor. Neither
 * reads or writes PLM data — the wrapper is there for the audit row and the
 * same baseline permission `offer_navigation` charges.
 */

import { withPermissionAndAudit } from './permission-wrapper'
import {
  requestUserInputInputSchema,
  suggestActionsInputSchema,
} from './dialog-definitions'
import type { ToolContext } from './permission-wrapper'
import type {
  RequestUserInputInput,
  SuggestActionsInput,
} from './dialog-definitions'
import type { z } from 'zod'
import type {
  ActionsDialogPayload,
  ChatDialogDescriptor,
  FormDialogPayload,
} from '@cascadia/commons/ai/dialogs'
import { presentDialog } from '@/ai/dialogs/DialogService'
import { ValidationError } from '@/errors'

interface DialogToolResult {
  dialog?: ChatDialogDescriptor
  displayed: boolean
  error?: string
}

/**
 * Validate a model-authored dialog against its schema.
 *
 * TanStack AI hands a handler the model's arguments as parsed JSON without
 * validating them against the input schema, and the registry documents
 * pre-validation as a caller convention. A dialog is stored and then rendered
 * by the browser — `href`s become navigation, labels become markup — so this
 * is the one gate that matters, and it does not depend on the convention
 * being honoured. The message names the field, so the model can fix its call.
 */
function parseDialog<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(input)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
      .join('; ')
    throw new ValidationError(`Invalid dialog: ${detail}`)
  }
  return result.data
}

/** Checks the schema cannot express: a select needs choices, names are keys. */
function validateFormFields(fields: FormDialogPayload['fields']): void {
  const seen = new Set<string>()
  for (const field of fields) {
    if (seen.has(field.name)) {
      throw new ValidationError(
        `Invalid dialog: duplicate field "${field.name}"`,
      )
    }
    seen.add(field.name)
    if (
      field.type === 'select' &&
      !field.optionsFrom &&
      !(field.options && field.options.length > 0)
    ) {
      throw new ValidationError(
        `Invalid dialog: select field "${field.name}" needs options or optionsFrom`,
      )
    }
  }
}

/** An action has to do something; an input has to have somewhere to put the value. */
function validateActions(payload: ActionsDialogPayload): void {
  if (payload.actions.length === 0 && !payload.inputs?.length) {
    throw new ValidationError(
      'Invalid dialog: suggest at least one action or input',
    )
  }
  for (const action of payload.actions) {
    if (!action.message && !action.href) {
      throw new ValidationError(
        `Invalid dialog: action "${action.label}" needs a message or an href`,
      )
    }
  }
  for (const input of payload.inputs ?? []) {
    if (!input.messageTemplate.includes('{value}')) {
      throw new ValidationError(
        `Invalid dialog: input "${input.label}" has a messageTemplate without {value}`,
      )
    }
  }
}

/** What the model is told when it asked for a dialog with no panel to show it. */
const NO_PANEL: DialogToolResult = {
  displayed: false,
  error:
    'Dialogs need the in-app chat panel, which is not listening here. Ask in your reply instead.',
}

// ============================================================================
// request_user_input handler
// ============================================================================

export const requestUserInputHandler = withPermissionAndAudit(
  'request_user_input',
  { resource: 'parts', action: 'read' },
  async (
    input: RequestUserInputInput,
    context: ToolContext,
  ): Promise<DialogToolResult> => {
    const { title, ...payload } = parseDialog(
      requestUserInputInputSchema,
      input,
    )
    validateFormFields(payload.fields)

    const dialog = await presentDialog(context, 'request_user_input', {
      kind: 'form',
      title,
      payload,
      label: 'Fill in details',
      summary:
        'The user sees a "Fill in details" button. Their answers arrive as their next message once they submit — wait for it rather than asking the same questions in text.',
    })
    if (!dialog) return NO_PANEL
    return { dialog, displayed: true }
  },
)

// ============================================================================
// suggest_actions handler
// ============================================================================

export const suggestActionsHandler = withPermissionAndAudit(
  'suggest_actions',
  { resource: 'parts', action: 'read' },
  async (
    input: SuggestActionsInput,
    context: ToolContext,
  ): Promise<DialogToolResult> => {
    const { title, ...payload } = parseDialog(suggestActionsInputSchema, input)
    validateActions(payload)

    const dialog = await presentDialog(context, 'suggest_actions', {
      kind: 'actions',
      title,
      payload,
      label: 'See suggested actions',
      summary:
        'The user sees a "See suggested actions" button. A clicked action arrives as their next message; briefly say what the suggestions cover rather than listing them all.',
    })
    if (!dialog) return NO_PANEL
    return { dialog, displayed: true }
  },
)
