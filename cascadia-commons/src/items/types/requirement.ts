// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { baseItemSchema } from './base'
import type { BaseItem } from './base'

// How a requirement is verified, and how far that verification has got.
// Schemas rather than bare unions so the API's requirement update schema can
// validate against these values instead of keeping a copy: its lowercase copy
// of the method enum rejected every value the column and the detail page use.
export const verificationMethodSchema = z.enum([
  'Analysis',
  'Inspection',
  'Demonstration',
  'Test',
  'Documentation',
])
export type VerificationMethod = z.infer<typeof verificationMethodSchema>

/**
 * Derived, never hand-set: the rollup of the latest execution of every test
 * case that verifies the requirement, or `Waived` while a waiver is recorded.
 */
export const verificationStatusSchema = z.enum([
  'NotStarted',
  'InProgress',
  'Passed',
  'Failed',
  'Waived',
])
export type VerificationStatus = z.infer<typeof verificationStatusSchema>

/**
 * The manual exception to the derived status: who waived verification, when,
 * and why. Present exactly while the status reads `Waived`.
 */
export const verificationWaiverSchema = z.object({
  note: z.string().min(1).max(2000),
  /** Null for a waiver that predates the record. */
  waivedBy: z.string().uuid().nullable(),
  /** ISO timestamp. */
  waivedAt: z.string(),
})
export type VerificationWaiver = z.infer<typeof verificationWaiverSchema>

// Requirement classification. Exported as a schema (not just a union) because
// the AI/MCP `create_item` tool advertises these values to models — deriving
// its enum from here is what keeps the two from drifting apart, which is how
// three never-valid values ended up in the tool schema.
export const requirementTypeSchema = z.enum([
  'Functional',
  'Non-Functional',
  'Performance',
  'Security',
  'Usability',
  'Business',
])
export type RequirementType = z.infer<typeof requirementTypeSchema>

export const requirementPrioritySchema = z.enum([
  'MustHave',
  'ShouldHave',
  'CouldHave',
  'WontHave',
])
export type RequirementPriority = z.infer<typeof requirementPrioritySchema>

// Requirement-specific interface
export interface Requirement extends BaseItem {
  itemType: 'Requirement'
  designId: string // Required for Requirements - links to versioning system
  description?: string
  type?: RequirementType
  priority?: RequirementPriority
  acceptanceCriteria?: string
  source?: string
  category?: string
  // Phase 2: Verification and traceability fields
  verificationMethod?: VerificationMethod
  /** Read-only: derived from the verifying tests' executions, or waived. */
  verificationStatus?: VerificationStatus
  verificationWaiver?: VerificationWaiver | null
  parentRequirementId?: string
}

// Requirement validation schema
export const requirementSchema = baseItemSchema.extend({
  itemType: z.literal('Requirement'),
  designId: z.string().uuid({ message: 'Design is required' }), // Required for Requirements
  description: z.string().max(5000).optional(),
  type: requirementTypeSchema.optional(),
  priority: requirementPrioritySchema.optional(),
  acceptanceCriteria: z.string().max(5000).optional(),
  source: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  // Phase 2: Verification and traceability fields
  verificationMethod: verificationMethodSchema.optional(),
  // `verificationStatus` is deliberately absent: it is derived from the
  // verifying tests' executions, and a waiver is its own request
  // (`POST /requirements/:id/waive`), so a hand-set value is stripped.
  parentRequirementId: z.string().uuid().optional(),
})

// Requirement relationships
export const requirementRelationships = [
  {
    type: 'Part',
    label: 'Related Parts',
    targetTypes: ['Part'],
    allowMultiple: true,
  },
  {
    type: 'Document',
    label: 'Related Documents',
    targetTypes: ['Document'],
    allowMultiple: true,
  },
  {
    type: 'Dependency',
    label: 'Dependencies',
    targetTypes: ['Requirement'],
    allowMultiple: true,
  },
]

// Export type for use in other modules
export type RequirementInput = z.infer<typeof requirementSchema>
