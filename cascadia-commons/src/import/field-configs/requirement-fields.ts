// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  requirementPrioritySchema,
  requirementTypeSchema,
  verificationMethodSchema,
} from '../../items/types/requirement'
import type { ItemFieldConfig } from './types'

/**
 * All importable requirement fields with their configurations.
 *
 * The enum values come from the requirement schema itself, so the sheet
 * accepts exactly what the column and the page accept. `parentItemNumber`
 * is how a hierarchy imports in one sheet: a row names its parent by item
 * number, either another row of the sheet or a requirement the design
 * already holds (`requirement-hierarchy.ts`).
 */
export const REQUIREMENT_FIELDS: Array<ItemFieldConfig> = [
  {
    field: 'itemNumber',
    label: 'Requirement Number',
    required: false,
    autoGenerate: true,
    aliases: [
      'requirement number',
      'requirement #',
      'requirement#',
      'req number',
      'req no',
      'req #',
      'req id',
      'requirement id',
      'item number',
      'number',
      'id',
      'identifier',
      'key',
    ],
    type: 'string',
    example: 'REQ-000001',
  },
  {
    field: 'name',
    label: 'Title',
    required: true,
    aliases: [
      'title',
      'name',
      'requirement',
      'requirement name',
      'requirement title',
      'statement',
      'summary',
      'short text',
      'heading',
    ],
    type: 'string',
    example: 'Rated payload 250 kg',
  },
  {
    field: 'revision',
    label: 'Revision',
    required: false,
    aliases: ['revision', 'rev', 'version'],
    type: 'string',
    example: '',
  },
  {
    field: 'description',
    label: 'Description',
    required: false,
    aliases: [
      'description',
      'desc',
      'text',
      'requirement text',
      'details',
      'body',
      'content',
      'object text',
      'rationale',
    ],
    type: 'string',
    example: 'The cart shall carry a rated payload of 250 kg on the bed.',
  },
  {
    field: 'type',
    label: 'Type',
    required: false,
    aliases: ['type', 'requirement type', 'kind', 'class', 'classification'],
    type: 'enum',
    enumValues: [...requirementTypeSchema.options],
    example: 'Performance',
  },
  {
    field: 'priority',
    label: 'Priority',
    required: false,
    aliases: ['priority', 'pri', 'moscow', 'importance', 'must/should'],
    type: 'enum',
    enumValues: [...requirementPrioritySchema.options],
    example: 'MustHave',
  },
  {
    field: 'category',
    label: 'Category',
    required: false,
    aliases: [
      'category',
      'group',
      'area',
      'section',
      'discipline',
      'subsystem',
    ],
    type: 'string',
    example: 'Performance',
  },
  {
    field: 'source',
    label: 'Source',
    required: false,
    aliases: [
      'source',
      'origin',
      'reference',
      'standard',
      'stakeholder',
      'customer',
    ],
    type: 'string',
    example: 'Product brief 2026-08',
  },
  {
    field: 'acceptanceCriteria',
    label: 'Acceptance Criteria',
    required: false,
    aliases: [
      'acceptance criteria',
      'acceptance',
      'criteria',
      'success criteria',
      'verification criteria',
      'pass criteria',
    ],
    type: 'string',
    example: 'Carries 250 kg with <= 5 mm deck deflection',
  },
  {
    field: 'verificationMethod',
    label: 'Verification Method',
    required: false,
    aliases: [
      'verification method',
      'method',
      'verification',
      'verify by',
      'v&v method',
      'vm',
    ],
    type: 'enum',
    enumValues: [...verificationMethodSchema.options],
    example: 'Test',
  },
  {
    field: 'parentItemNumber',
    label: 'Parent Requirement',
    required: false,
    aliases: [
      'parent requirement',
      'parent',
      'parent number',
      'parent item number',
      'parent req',
      'parent id',
      'derived from',
      'derives from',
      'refines',
    ],
    type: 'string',
    example: '',
  },
]

/**
 * The columns a requirements export writes: the import fields less
 * `revision`, so a sheet exported from one design imports into another as
 * fresh drafts — the revision an item held elsewhere is a migration's
 * business (`importAsReleased`), not a round trip's.
 */
export const REQUIREMENT_SHEET_FIELDS: Array<ItemFieldConfig> =
  REQUIREMENT_FIELDS.filter((field) => field.field !== 'revision')
