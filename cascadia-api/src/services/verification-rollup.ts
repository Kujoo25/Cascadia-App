// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray } from 'drizzle-orm'
import { isWorkingRevisionValue } from '@cascadia/commons/types/lifecycle'
import { itemRelationships, items, requirements, testCases } from '../db/schema'
import { REQUIREMENT_VERIFICATION_CHANGED, publishDomainEvent } from '../events'
import { VERIFIED_BY_RELATIONSHIP } from '../items/traceability-relationships'
import type { TransactionClient } from '../db'
import type { VerificationStatus } from '@cascadia/commons/items/types/requirement'

/**
 * Derived verification status.
 *
 * A requirement's `verificationStatus` is not something anyone sets. It is
 * the rollup of the latest execution of every test case that verifies the
 * requirement, recomputed inside the transaction that records an execution
 * or changes a `VERIFIED_BY` link, so the column can never say something the
 * executions do not. The one manual exception is a waiver
 * (`requirements.verification_waiver`): while one is recorded the status
 * reads `Waived` and the rollup leaves the row alone; clearing it recomputes.
 *
 * The rule, from the systems-engineering plan (§5.3):
 *
 * - any verifying test whose latest execution `Failed` → `Failed`
 * - every verifying test's latest execution `Passed`, at least one → `Passed`
 * - any execution at all → `InProgress`
 * - else → `NotStarted`
 *
 * "Every test case that verifies the requirement" is read by master, the way
 * the trace listings read it through the lineage walk: a `VERIFIED_BY` edge
 * names one requirement version row, and a release leaves it naming the row
 * it superseded, so the edges pointing at any revision of the master count
 * for the rows that answer for it now. Test cases carry a Free lifecycle and
 * never revise, so their side needs no such walk.
 *
 * Suspicion is not folded in here. A suspect `VERIFIED_BY` link changes
 * with no write — the requirement revises in a release and the claim is
 * stale by comparison — so it cannot be kept in a stored column. The readers
 * apply it: `isVerified` below is the one rule for "verified", and every
 * coverage read combines it with the link's suspect state.
 */

export type VerificationCause =
  'execution' | 'link' | 'unlink' | 'waiver_cleared'

/** The derived status for a set of verifying tests' latest results. */
export function deriveVerificationStatus(
  latestResults: ReadonlyArray<string | null>,
): Exclude<VerificationStatus, 'Waived'> {
  if (latestResults.some((result) => result === 'Failed')) return 'Failed'
  if (
    latestResults.length > 0 &&
    latestResults.every((result) => result === 'Passed')
  ) {
    return 'Passed'
  }
  if (
    latestResults.some(
      (result) =>
        result === 'Passed' || result === 'Failed' || result === 'Blocked',
    )
  ) {
    return 'InProgress'
  }
  return 'NotStarted'
}

/**
 * The one rule for "verified": a `Passed` derivation or a recorded waiver.
 * Every coverage read combines it with the claim's suspect state — a claim
 * under review is not evidence — which is why that half lives with the
 * readers (`items/trace-affirmation.ts`) and not here.
 */
export function isVerifiedStatus(status: string | null | undefined): boolean {
  return status === 'Passed' || status === 'Waived'
}

/**
 * The masters of every requirement the named test cases verify, through
 * whichever revision's row each edge names.
 */
export async function requirementMastersVerifiedBy(
  tx: TransactionClient,
  testCaseIds: Array<string>,
): Promise<Array<string>> {
  const ids = [...new Set(testCaseIds)]
  if (ids.length === 0) return []
  const rows = await tx
    .select({ masterId: items.masterId })
    .from(itemRelationships)
    .innerJoin(items, eq(items.id, itemRelationships.targetId))
    .where(
      and(
        inArray(itemRelationships.sourceId, ids),
        eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
      ),
    )
  return [...new Set(rows.map((row) => row.masterId))]
}

export interface VerificationRollupChange {
  requirementId: string
  masterId: string
  previousStatus: string | null
  status: VerificationStatus
}

/**
 * Recompute the stored status of every row that answers for each master —
 * the current released row, and any working copy a branch is editing — and
 * record a `requirement.verification_changed` fact for each row it moves.
 * Rows under a waiver keep it. Returns what changed.
 */
export async function rollupVerificationForMasters(
  tx: TransactionClient,
  masterIds: Array<string>,
  options: {
    actorId: string | null
    cause: VerificationCause
    /** The test case whose execution or link caused the recompute, if one. */
    testCaseId?: string
  },
): Promise<Array<VerificationRollupChange>> {
  const masters = [...new Set(masterIds)]
  if (masters.length === 0) return []

  const rows = await tx
    .select({
      id: items.id,
      masterId: items.masterId,
      itemNumber: items.itemNumber,
      designId: items.designId,
      revision: items.revision,
      isCurrent: items.isCurrent,
      isDeleted: items.isDeleted,
      verificationStatus: requirements.verificationStatus,
      verificationWaiver: requirements.verificationWaiver,
    })
    .from(items)
    .innerJoin(requirements, eq(requirements.itemId, items.id))
    .where(
      and(inArray(items.masterId, masters), eq(items.itemType, 'Requirement')),
    )
  const answering = rows.filter(
    (row) =>
      !row.isDeleted && (row.isCurrent || isWorkingRevisionValue(row.revision)),
  )
  if (answering.length === 0) return []

  // The latest result of every test case verifying each master, through any
  // of the master's rows, each test counted once.
  const linked = await tx
    .select({
      masterId: items.masterId,
      testCaseId: testCases.itemId,
      executionStatus: testCases.executionStatus,
    })
    .from(itemRelationships)
    .innerJoin(items, eq(items.id, itemRelationships.targetId))
    .innerJoin(testCases, eq(testCases.itemId, itemRelationships.sourceId))
    .where(
      and(
        inArray(items.masterId, masters),
        eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
      ),
    )
  const sourceIds = [...new Set(linked.map((row) => row.testCaseId))]
  const liveSources = new Set(
    sourceIds.length > 0
      ? (
          await tx
            .select({ id: items.id })
            .from(items)
            .where(
              and(
                inArray(items.id, sourceIds),
                eq(items.isCurrent, true),
                eq(items.isDeleted, false),
              ),
            )
        ).map((row) => row.id)
      : [],
  )
  const resultsByMaster = new Map<string, Map<string, string | null>>()
  for (const row of linked) {
    if (!liveSources.has(row.testCaseId)) continue
    let byTest = resultsByMaster.get(row.masterId)
    if (!byTest) {
      byTest = new Map()
      resultsByMaster.set(row.masterId, byTest)
    }
    byTest.set(row.testCaseId, row.executionStatus)
  }

  const changes: Array<VerificationRollupChange> = []
  for (const row of answering) {
    if (row.verificationWaiver) continue
    const status = deriveVerificationStatus([
      ...(resultsByMaster.get(row.masterId)?.values() ?? []),
    ])
    if (row.verificationStatus === status) continue

    await tx
      .update(requirements)
      .set({ verificationStatus: status })
      .where(eq(requirements.itemId, row.id))
    await publishDomainEvent(tx, REQUIREMENT_VERIFICATION_CHANGED, {
      actorId: options.actorId ?? undefined,
      subject: { id: row.id, masterId: row.masterId },
      context: { designId: row.designId ?? undefined },
      payload: {
        requirementId: row.id,
        masterId: row.masterId,
        itemNumber: row.itemNumber,
        designId: row.designId,
        previousStatus: row.verificationStatus,
        status,
        cause: options.cause,
        testCaseId: options.testCaseId ?? null,
      },
    })
    changes.push({
      requirementId: row.id,
      masterId: row.masterId,
      previousStatus: row.verificationStatus,
      status,
    })
  }
  return changes
}
