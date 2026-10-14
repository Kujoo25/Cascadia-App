// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { defineDomainEvent } from '../publish'

export const testExecutedPayloadSchema = z.object({
  executionId: z.string().uuid(),
  testCaseId: z.string().uuid(),
  testCaseMasterId: z.string().uuid(),
  itemNumber: z.string(),
  /** The result recorded: `Passed`, `Failed` or `Blocked`. */
  status: z.string(),
  executedBy: z.string().uuid(),
  designId: z.string().uuid().nullable(),
  /**
   * The masters of the requirements this test verifies, whose derived
   * verification status was recomputed in the same transaction. Each one
   * that moved also has its own `requirement.verification_changed`.
   */
  requirementMasterIds: z.array(z.string().uuid()),
})
export type TestExecutedPayload = z.infer<typeof testExecutedPayloadSchema>

/**
 * A test case execution was recorded.
 *
 * Emitted inside the transaction that writes the execution row, updates the
 * test case's latest result and recomputes the verification status of the
 * requirements it verifies, so the fact exists if and only if all of that
 * committed. Until this event a test run was invisible on the bus: the
 * `ItemService.update` bump it made changed nothing, so not even
 * `item.updated` fired.
 */
export const TEST_EXECUTED = defineDomainEvent({
  type: 'test.executed',
  schemaVersion: 1,
  description: 'A test case execution was recorded',
  subjectType: 'item',
  payloadSchema: testExecutedPayloadSchema,
})

export const requirementVerificationChangedPayloadSchema = z.object({
  requirementId: z.string().uuid(),
  masterId: z.string().uuid(),
  itemNumber: z.string(),
  designId: z.string().uuid().nullable(),
  previousStatus: z.string().nullable(),
  /** `NotStarted`, `InProgress`, `Passed`, `Failed` or `Waived`. */
  status: z.string(),
  /**
   * What moved it: a recorded execution, a verification link made or
   * removed, a waiver recorded, or a waiver cleared (which puts the derived
   * status back).
   */
  cause: z.enum(['execution', 'link', 'unlink', 'waiver', 'waiver_cleared']),
  /** The test case behind an `execution`, `link` or `unlink` cause. */
  testCaseId: z.string().uuid().nullable(),
})
export type RequirementVerificationChangedPayload = z.infer<
  typeof requirementVerificationChangedPayloadSchema
>

/**
 * A requirement's verification status moved.
 *
 * The status is derived (`services/verification-rollup.ts`), so this is the
 * fact a consumer waits on rather than `test.executed`: one per requirement
 * row whose stored status actually changed, in the transaction that changed
 * it. A run that leaves every status where it was emits none of these.
 */
export const REQUIREMENT_VERIFICATION_CHANGED = defineDomainEvent({
  type: 'requirement.verification_changed',
  schemaVersion: 1,
  description: "A requirement's verification status moved",
  subjectType: 'item',
  payloadSchema: requirementVerificationChangedPayloadSchema,
})
