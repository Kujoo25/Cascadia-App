// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Chat dialogs — the contract between a tool result and the modal it opens.
 *
 * A chat message is the wrong place for three hundred search hits, a BOM
 * graph, or a form. A tool that has one of those to show stores it as a
 * dialog (`DialogService`) and puts only a small *descriptor* in its result:
 * the model reads the descriptor and knows a button exists, the chat panel
 * renders the button, and the full payload is fetched when the button is
 * clicked. The model never has to carry the payload through its context, and
 * the payload outlives the stream — it is what lets a reopened conversation
 * still open its dialogs.
 *
 * Four kinds, two authors:
 *
 * - `data-grid` and `graph` are built server-side by the read tools from the
 *   rows they already fetched.
 * - `form` and `actions` are authored by the model through the
 *   `request_user_input` and `suggest_actions` tools; the schemas below are
 *   what those tools validate against before anything is stored.
 *
 * This module is shared by the server, the tool definitions and the browser
 * bundle, so it imports zod and nothing else — in particular nothing that
 * reaches the database.
 */

import { z } from 'zod'

export const DIALOG_KINDS = ['data-grid', 'graph', 'form', 'actions'] as const
export type ChatDialogKind = (typeof DIALOG_KINDS)[number]

/**
 * A path in this app, and nothing else. Same rule as `toAppRelativeUrl`, the
 * markdown egress gate: a `/` followed by neither `/` nor `\` (both resolve to
 * another origin in a browser's URL parser), then no whitespace. The model
 * writes these after reading tool results — item names and descriptions any
 * user with write access authored — so what it hands the UI to navigate to
 * cannot be trusted to stay on this origin without a check.
 */
export const appRelativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(
    /^\/(?![/\\])\S*$/,
    'Must be an app-relative path such as /parts/{id}, never an external URL',
  )

// ─── What rides in a tool result ────────────────────────────────────────────

/**
 * The part of a dialog that a tool result carries. Small on purpose: it is
 * what the model reads and what the chat panel needs to draw the button.
 */
export interface ChatDialogDescriptor {
  id: string
  kind: ChatDialogKind
  title: string
  /** Button text. The panel falls back to a per-kind default. */
  label?: string
  /**
   * Model-facing note about what the dialog holds and what to leave to it —
   * "the button under this message opens all 312 matches", so the model
   * summarises the top few instead of pasting the list.
   */
  summary?: string
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether a parsed tool result carries a dialog descriptor. The id is checked
 * as a UUID because the panel puts it straight into a request path.
 */
export function dialogDescriptorOf(
  result: unknown,
): ChatDialogDescriptor | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const candidate = (result as { dialog?: unknown }).dialog
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const { id, kind, title, label, summary } = candidate as Record<
    string,
    unknown
  >
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) return undefined
  if (
    typeof kind !== 'string' ||
    !(DIALOG_KINDS as ReadonlyArray<string>).includes(kind)
  ) {
    return undefined
  }
  if (typeof title !== 'string') return undefined
  return {
    id,
    kind: kind as ChatDialogKind,
    title,
    label: typeof label === 'string' ? label : undefined,
    summary: typeof summary === 'string' ? summary : undefined,
  }
}

/** The descriptor's shape, for the read tools' output schemas. */
export const dialogDescriptorSchema = z.object({
  id: z.string(),
  kind: z.enum(DIALOG_KINDS),
  title: z.string(),
  label: z.string().optional(),
  summary: z.string().optional(),
})

// ─── data-grid ──────────────────────────────────────────────────────────────

export interface DialogGridColumn {
  id: string
  header: string
  /**
   * How a cell renders. `link` navigates to the row's `href`; `state` renders
   * the lifecycle badge for the row's `itemType`.
   */
  type?: 'text' | 'number' | 'state' | 'link'
}

/** One row. `href` is where a `link` cell (or the row's context menu) goes. */
export interface DialogGridRow {
  [column: string]: unknown
  href?: string
  itemType?: string
  children?: Array<DialogGridRow>
}

export interface DataGridDialogPayload {
  columns: Array<DialogGridColumn>
  rows: Array<DialogGridRow>
  /** How many rows matched in total, which exceeds `rows.length` when capped. */
  total: number
  /** True when `rows` stops at the cap and `total` is larger. */
  truncated: boolean
  /** Rows carry `children` — render as a tree. */
  hierarchical?: boolean
}

// ─── graph ──────────────────────────────────────────────────────────────────

export interface DialogGraphNode {
  id: string
  label: string
  sublabel?: string
  /** Lifecycle state, rendered as a badge. */
  state?: string
  itemType?: string
  href?: string
  /** 0 is the item the graph is about. */
  depth: number
}

export interface DialogGraphEdge {
  source: string
  target: string
  label?: string
}

export interface GraphDialogPayload {
  nodes: Array<DialogGraphNode>
  edges: Array<DialogGraphEdge>
  /** Layout direction; `TB` puts edge sources above their targets. */
  direction?: 'TB' | 'LR'
  /** One line explaining what an edge means, shown under the graph. */
  legend?: string
  /** How many nodes there were before the cap, when `truncated`. */
  total?: number
  /** True when the graph stops at the node cap. */
  truncated?: boolean
  /** The same data as a table, offered as a second tab. */
  table?: DataGridDialogPayload
}

// ─── form (model-authored) ──────────────────────────────────────────────────

export const dialogFormFieldTypeSchema = z.enum([
  'text',
  'textarea',
  'number',
  'select',
  'checkbox',
  'date',
])
export type DialogFormFieldType = z.infer<typeof dialogFormFieldTypeSchema>

export const dialogFormFieldSchema = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/)
    .describe('Field key, e.g. "partType". Letters, digits, underscores.'),
  label: z.string().min(1).max(120).describe('Label shown to the user'),
  type: dialogFormFieldTypeSchema
    .default('text')
    .describe(
      'Control type. "select" needs options or optionsFrom; "checkbox" is a yes/no.',
    ),
  required: z.boolean().optional(),
  placeholder: z.string().max(200).optional(),
  helpText: z.string().max(300).optional(),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        value: z.string().min(1).max(200),
      }),
    )
    .max(100)
    .optional()
    .describe('Choices for a select field'),
  optionsFrom: z
    .enum(['designs', 'programs'])
    .optional()
    .describe(
      'Fill a select from live data instead of options: the designs or programs the user can access. The submitted value is the id.',
    ),
  defaultValue: z
    .union([z.string().max(2000), z.number(), z.boolean()])
    .optional(),
})
export type DialogFormField = z.infer<typeof dialogFormFieldSchema>

export const formDialogPayloadSchema = z.object({
  description: z
    .string()
    .max(1000)
    .optional()
    .describe('One or two sentences explaining what the details are for'),
  fields: z.array(dialogFormFieldSchema).min(1).max(20),
  submitLabel: z.string().min(1).max(40).optional(),
})
export type FormDialogPayload = z.infer<typeof formDialogPayloadSchema>

// ─── actions (model-authored) ───────────────────────────────────────────────

export const dialogActionSchema = z.object({
  label: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  message: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      'Chat message sent on the user\'s behalf when clicked, e.g. "Show me the maintenance history of the CNC mill"',
    ),
  href: appRelativePathSchema
    .optional()
    .describe('App-relative page to open instead, e.g. /tools/new'),
})
export type DialogAction = z.infer<typeof dialogActionSchema>

export const dialogActionInputSchema = z.object({
  label: z.string().min(1).max(80),
  placeholder: z.string().max(200).optional(),
  buttonLabel: z.string().min(1).max(40).optional(),
  messageTemplate: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      'Chat message sent with {value} replaced by what the user typed, e.g. "Create a new tool from this product page: {value}"',
    ),
})
export type DialogActionInput = z.infer<typeof dialogActionInputSchema>

export const actionsDialogPayloadSchema = z.object({
  description: z.string().max(1000).optional(),
  actions: z.array(dialogActionSchema).max(20),
  inputs: z
    .array(dialogActionInputSchema)
    .max(5)
    .optional()
    .describe('Free-text boxes, each with its own button'),
})
export type ActionsDialogPayload = z.infer<typeof actionsDialogPayloadSchema>

// ─── the stored dialog ──────────────────────────────────────────────────────

export interface DialogPayloads {
  'data-grid': DataGridDialogPayload
  graph: GraphDialogPayload
  form: FormDialogPayload
  actions: ActionsDialogPayload
}

export type ChatDialogPayload = DialogPayloads[ChatDialogKind]

interface ChatDialogBase {
  id: string
  title: string
  toolName: string
  createdAt: string
}

/** A dialog as `GET /api/v1/ai/dialogs/:id` returns it. */
export type ChatDialog = {
  [K in ChatDialogKind]: ChatDialogBase & {
    kind: K
    payload: DialogPayloads[K]
  }
}[ChatDialogKind]
