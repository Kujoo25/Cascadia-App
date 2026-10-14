// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { z } from 'zod'
import { baseItemSchema } from './base'
import type { BaseItem } from './base'

/**
 * Where an element sits in the architecture: the system itself, a segment of
 * it, a subsystem, or a module. A label for the reader, not a constraint —
 * `DECOMPOSES` is the tree, and nothing checks that a module sits under a
 * subsystem. Exported as a schema so the API's update schema and the form
 * read one list.
 */
export const systemElementKindSchema = z.enum([
  'system',
  'segment',
  'subsystem',
  'module',
])
export type SystemElementKind = z.infer<typeof systemElementKindSchema>

export const SYSTEM_ELEMENT_KINDS: ReadonlyArray<SystemElementKind> =
  systemElementKindSchema.options

export const SYSTEM_ELEMENT_KIND_LABELS: Record<SystemElementKind, string> = {
  system: 'System',
  segment: 'Segment',
  subsystem: 'Subsystem',
  module: 'Module',
}

/**
 * A logical element of the system architecture — what a requirement is
 * allocated to before any part exists, and what a part later realizes.
 *
 * Versioned and Driven like a Part: an element releases through a change
 * order and revises on a branch, so the architecture tree an ECO reshapes is
 * isolated until the release, exactly as the BOM is. The tree itself is the
 * `DECOMPOSES` edge (element → child element) and is deliberately not the
 * BOM: one tree serving two masters was rejected in the systems-engineering
 * proposal. `REALIZED_BY` (element → Part/Software) is the logical-to-physical
 * hop the requirements matrix follows.
 */
export interface SystemElement extends BaseItem {
  itemType: 'SystemElement'
  /** Required: an element belongs to a design, which versions it. */
  designId: string
  elementKind?: SystemElementKind
  description?: string
}

export const systemElementSchema = baseItemSchema.extend({
  itemType: z.literal('SystemElement'),
  designId: z.string().uuid({ message: 'Design is required' }),
  elementKind: systemElementKindSchema.optional(),
  description: z.string().max(5000).optional(),
})

// The cataloged edges an element is the source of; the catalog
// (`relationships/catalog.ts`) fixes their ends and the relationship service
// polices them.
export const systemElementRelationships = [
  {
    type: 'DECOMPOSES',
    label: 'Decomposes into',
    targetTypes: ['SystemElement'],
    allowMultiple: true,
  },
  {
    type: 'REALIZED_BY',
    label: 'Realized by',
    targetTypes: ['Part', 'Software'],
    allowMultiple: true,
  },
]

export type SystemElementInput = z.infer<typeof systemElementSchema>
