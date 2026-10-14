// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { designs } from '../db/schema/designs'
import {
  itemRelationships,
  items,
  requirements,
  testCases,
  testExecutions,
} from '../db/schema/items'
import { users } from '../db/schema/users'
import { notDeleted } from '../db/filters'
import { NotFoundError, ValidationError } from '../errors'
import { TEST_EXECUTED, publishDomainEvent } from '../events'
import { ItemService } from '../items/services/ItemService'
import { ItemRelationshipService } from '../items/services/ItemRelationshipService'
import { VALIDATES_RELATIONSHIP } from '../items/traceability-relationships'
import {
  VERIFIED_BY_RELATIONSHIP,
  idsWithLinks,
  requirementsWithSuspectLinks,
  suspectFields,
} from './RequirementService'
import {
  isVerifiedStatus,
  requirementMastersVerifiedBy,
  rollupVerificationForMasters,
} from './verification-rollup'
import type { TransactionClient } from '../db'
import type { SuspectLinkFields } from './RequirementService'
import type { ExecutionStatus } from '@cascadia/commons/items/types/testcase'
import { takeFirst } from '@/db/take-first'

/**
 * Relationship type constant for test-to-part validation. Declared in
 * `items/traceability-relationships` beside its siblings; re-exported here
 * for the callers that always found it on this service.
 */
export { VALIDATES_RELATIONSHIP }

/**
 * Test execution result
 */
export interface TestExecutionResult {
  id: string
  testCaseId: string
  executorId: string
  executorName: string
  executedAt: Date
  status: string
  duration: number | null
  environment: string | null
  actualResults: string | null
  notes: string | null
}

/**
 * Test coverage metrics for a design
 */
export interface TestCoverage {
  totalRequirements: number
  /** Requirements with at least one verifying test linked — a plan. */
  requirementsWithTests: number
  /**
   * Requirements verified by the one rule: derived status Passed or a
   * waiver recorded, and no suspect verifying claim.
   */
  requirementsVerified: number
  coveragePercent: number
  verifiedPercent: number
  totalTests: number
  passed: number
  failed: number
  notRun: number
  blocked: number
  passedPercent: number
  failedPercent: number
}

/**
 * Verification gap - requirements without test cases
 */
export interface VerificationGap {
  id: string
  itemNumber: string
  name: string | null
  priority: string | null
  verificationMethod: string | null
  /** The derived status the gap was judged on. */
  verificationStatus: string | null
}

/**
 * Validating test for a part
 */
export interface ValidatingTest extends SuspectLinkFields {
  id: string
  itemNumber: string
  name: string | null
  testType: string | null
  executionStatus: string | null
  lastExecutedAt: Date | null
  relationshipId: string
}

/**
 * Validated part by a test
 */
export interface ValidatedPart extends SuspectLinkFields {
  id: string
  itemNumber: string
  name: string | null
  state: string
  relationshipId: string
}

/**
 * A test case listed under its parent test plan.
 */
export interface TestPlanTestCase {
  id: string
  itemNumber: string
  name: string | null
  state: string
  testType: string | null
  executionStatus: string | null
  lastExecutedAt: Date | null
}

/**
 * Service for test verification and validation tracking
 */
export class VerificationService {
  /**
   * Record a test execution result.
   * Updates the test case execution status and creates an execution history record.
   */
  static async recordExecution(
    testCaseId: string,
    result: {
      status: ExecutionStatus
      duration?: number
      environment?: string
      actualResults?: string
      notes?: string
    },
    userId: string,
  ): Promise<TestExecutionResult> {
    // Verify test case exists
    const testCase = await ItemService.findById(testCaseId)
    if (!testCase || testCase.itemType !== 'TestCase') {
      throw new NotFoundError('TestCase', testCaseId, {
        operation: 'recordExecution',
      })
    }

    // One transaction: the history row, the test case's latest result, the
    // derived status of every requirement the test verifies, and the fact
    // that says so. Recording a run is runtime metadata, not content
    // authoring — it must work on a Released test case without a checkout,
    // so none of this goes through the edit lock.
    const execution = await db.transaction(async (tx) => {
      const inserted = takeFirst(
        await tx
          .insert(testExecutions)
          .values({
            testCaseId,
            executorId: userId,
            status: result.status,
            duration: result.duration ?? null,
            environment: result.environment ?? null,
            actualResults: result.actualResults ?? null,
            notes: result.notes ?? null,
          })
          .returning(),
      )

      await this.writeLatestResult(
        tx,
        testCaseId,
        result.status,
        userId,
        result.environment ?? null,
      )

      const requirementMasterIds = await requirementMastersVerifiedBy(tx, [
        testCaseId,
      ])
      await rollupVerificationForMasters(tx, requirementMasterIds, {
        actorId: userId,
        cause: 'execution',
        testCaseId,
      })

      await publishDomainEvent(tx, TEST_EXECUTED, {
        actorId: userId,
        subject: { id: testCaseId, masterId: testCase.masterId },
        context: { designId: testCase.designId ?? undefined },
        payload: {
          executionId: inserted.id,
          testCaseId,
          testCaseMasterId: testCase.masterId,
          itemNumber: testCase.itemNumber,
          status: result.status,
          executedBy: userId,
          designId: testCase.designId ?? null,
          requirementMasterIds,
        },
      })

      return inserted
    })

    // Get executor name for response
    const [executor] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    return {
      id: execution.id,
      testCaseId: execution.testCaseId,
      executorId: execution.executorId,
      executorName: executor?.name ?? 'Unknown',
      executedAt: execution.executedAt,
      status: execution.status,
      duration: execution.duration,
      environment: execution.environment,
      actualResults: execution.actualResults,
      notes: execution.notes,
    }
  }

  /**
   * The test case's latest result and the item's modified stamp, in the
   * caller's transaction. The stamp used to come from an empty
   * `ItemService.update`, which changed nothing and so emitted nothing; the
   * fact of the run is `test.executed` now, and the stamp is written here.
   */
  private static async writeLatestResult(
    tx: TransactionClient,
    testCaseId: string,
    status: ExecutionStatus,
    userId: string,
    environment: string | null | undefined,
  ): Promise<void> {
    const now = new Date()
    await tx
      .update(testCases)
      .set({
        executionStatus: status,
        lastExecutedAt: now,
        lastExecutedBy: userId,
        ...(environment === undefined ? {} : { environment }),
      })
      .where(eq(testCases.itemId, testCaseId))
    await tx
      .update(items)
      .set({ modifiedAt: now, modifiedBy: userId })
      .where(eq(items.id, testCaseId))
  }

  /**
   * List the test cases belonging to a test plan.
   *
   * Parentage lives on `test_cases.test_plan_master_id` rather than in
   * `item_relationships`, so this is a direct join rather than an edge walk.
   * Matched by the plan's master, so whichever row of the plan the caller
   * names answers the same, and within the plan's own design: a clone
   * re-points its cases at the clone's plan, and a usage pulled into another
   * design starts with no plan, but a row that still names this master from
   * another design is that design's business, not this listing's. Deleted
   * rows are excluded; the caller renders the pass/fail rollup from
   * `executionStatus`.
   */
  static async getTestCasesForPlan(
    testPlanId: string,
  ): Promise<Array<TestPlanTestCase>> {
    const plan = await ItemService.findById(testPlanId)
    if (!plan || plan.itemType !== 'TestPlan') {
      throw new NotFoundError('TestPlan', testPlanId, {
        operation: 'getTestCasesForPlan',
      })
    }

    return db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        state: items.state,
        testType: testCases.testType,
        executionStatus: testCases.executionStatus,
        lastExecutedAt: testCases.lastExecutedAt,
      })
      .from(testCases)
      .innerJoin(items, eq(items.id, testCases.itemId))
      .where(
        and(
          eq(testCases.testPlanMasterId, plan.masterId),
          plan.designId ? eq(items.designId, plan.designId) : undefined,
          notDeleted(),
          eq(items.isCurrent, true),
        ),
      )
      .orderBy(items.itemNumber)
  }

  /**
   * Get execution history for a test case.
   */
  static async getExecutionHistory(
    testCaseId: string,
    limit: number = 20,
  ): Promise<Array<TestExecutionResult>> {
    const executions = await db
      .select({
        id: testExecutions.id,
        testCaseId: testExecutions.testCaseId,
        executorId: testExecutions.executorId,
        executorName: users.name,
        executedAt: testExecutions.executedAt,
        status: testExecutions.status,
        duration: testExecutions.duration,
        environment: testExecutions.environment,
        actualResults: testExecutions.actualResults,
        notes: testExecutions.notes,
      })
      .from(testExecutions)
      .leftJoin(users, eq(testExecutions.executorId, users.id))
      .where(eq(testExecutions.testCaseId, testCaseId))
      .orderBy(desc(testExecutions.executedAt))
      .limit(limit)

    return executions.map((e) => ({
      ...e,
      executorName: e.executorName ?? 'Unknown',
    }))
  }

  /**
   * Get test coverage metrics for a design.
   */
  static async getTestCoverage(designId: string): Promise<TestCoverage> {
    // Verify design exists
    const [design] = await db
      .select()
      .from(designs)
      .where(eq(designs.id, designId))
      .limit(1)

    if (!design) {
      throw new NotFoundError('Design', designId, {
        operation: 'getTestCoverage',
      })
    }

    // Get all requirements for this design
    const allRequirements = await db
      .select({
        id: items.id,
        verificationStatus: requirements.verificationStatus,
      })
      .from(items)
      .innerJoin(requirements, eq(requirements.itemId, items.id))
      .where(
        and(
          eq(items.designId, designId),
          eq(items.itemType, 'Requirement'),
          eq(items.isCurrent, true),
        ),
      )

    const totalRequirements = allRequirements.length
    if (totalRequirements === 0) {
      return {
        totalRequirements: 0,
        requirementsWithTests: 0,
        requirementsVerified: 0,
        coveragePercent: 0,
        verifiedPercent: 0,
        totalTests: 0,
        passed: 0,
        failed: 0,
        notRun: 0,
        blocked: 0,
        passedPercent: 0,
        failedPercent: 0,
      }
    }

    const requirementIds = allRequirements.map((r) => r.id)

    // Count requirements with VERIFIED_BY relationships. Version-aware: the
    // edge belongs to the test case, so a release leaves it naming the
    // requirement row it superseded.
    const verifyingLinks = await ItemRelationshipService.findIncomingLinks(
      requirementIds,
      VERIFIED_BY_RELATIONSHIP,
    )
    const requirementsWithTests = idsWithLinks(verifyingLinks).size

    // Verified by the one rule every coverage read applies: the derived
    // status says Passed (or a waiver is recorded), and no verifying claim is
    // suspect — a claim under review is not evidence.
    const suspectVerified = await requirementsWithSuspectLinks(verifyingLinks)
    const requirementsVerified = allRequirements.filter(
      (r) =>
        isVerifiedStatus(r.verificationStatus) && !suspectVerified.has(r.id),
    ).length

    // Get all test cases for this design
    const allTestCases = await db
      .select({
        id: items.id,
        executionStatus: testCases.executionStatus,
      })
      .from(items)
      .innerJoin(testCases, eq(items.id, testCases.itemId))
      .where(
        and(
          eq(items.designId, designId),
          eq(items.itemType, 'TestCase'),
          eq(items.isCurrent, true),
        ),
      )

    // Count execution statuses
    let passed = 0
    let failed = 0
    let notRun = 0
    let blocked = 0

    for (const tc of allTestCases) {
      switch (tc.executionStatus) {
        case 'Passed':
          passed++
          break
        case 'Failed':
          failed++
          break
        case 'Blocked':
          blocked++
          break
        default:
          notRun++
          break
      }
    }

    const totalTests = allTestCases.length
    const passedPercent =
      totalTests > 0 ? Math.round((passed / totalTests) * 1000) / 10 : 0
    const failedPercent =
      totalTests > 0 ? Math.round((failed / totalTests) * 1000) / 10 : 0

    return {
      totalRequirements,
      requirementsWithTests,
      requirementsVerified,
      coveragePercent:
        Math.round((requirementsWithTests / totalRequirements) * 1000) / 10,
      verifiedPercent:
        Math.round((requirementsVerified / totalRequirements) * 1000) / 10,
      totalTests,
      passed,
      failed,
      notRun,
      blocked,
      passedPercent,
      failedPercent,
    }
  }

  /**
   * The requirements that are not verified: by the one rule, their derived
   * status is not Passed and no waiver is recorded, or a verifying claim is
   * suspect. A requirement with a linked test that has never run is a gap —
   * the link is a plan, not evidence.
   */
  static async getVerificationGaps(
    designId: string,
  ): Promise<Array<VerificationGap>> {
    // Get all requirements for this design
    const allRequirements = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        priority: requirements.priority,
        verificationMethod: requirements.verificationMethod,
        verificationStatus: requirements.verificationStatus,
      })
      .from(items)
      .innerJoin(requirements, eq(items.id, requirements.itemId))
      .where(
        and(
          eq(items.designId, designId),
          eq(items.itemType, 'Requirement'),
          eq(items.isCurrent, true),
        ),
      )

    if (allRequirements.length === 0) {
      return []
    }

    const requirementIds = allRequirements.map((r) => r.id)

    // Version-aware, so a revision does not read back as a fresh gap.
    const suspectVerified = await requirementsWithSuspectLinks(
      await ItemRelationshipService.findIncomingLinks(
        requirementIds,
        VERIFIED_BY_RELATIONSHIP,
      ),
    )

    const gaps = allRequirements
      .filter(
        (r) =>
          !isVerifiedStatus(r.verificationStatus) || suspectVerified.has(r.id),
      )
      .map((r) => ({
        id: r.id,
        itemNumber: r.itemNumber,
        name: r.name,
        priority: r.priority,
        verificationMethod: r.verificationMethod,
        verificationStatus: r.verificationStatus,
      }))

    // Sort by priority (MustHave first)
    const priorityOrder = ['MustHave', 'ShouldHave', 'CouldHave', 'WontHave']
    gaps.sort((a, b) => {
      const aOrder = a.priority
        ? priorityOrder.indexOf(a.priority)
        : priorityOrder.length
      const bOrder = b.priority
        ? priorityOrder.indexOf(b.priority)
        : priorityOrder.length
      return aOrder - bOrder
    })

    return gaps
  }

  /**
   * Update the execution status of a test case.
   */
  static async updateTestStatus(
    testCaseId: string,
    status: ExecutionStatus,
    userId: string,
  ): Promise<void> {
    // Verify test case exists
    const testCase = await ItemService.findById(testCaseId)
    if (!testCase || testCase.itemType !== 'TestCase') {
      throw new NotFoundError('TestCase', testCaseId, {
        operation: 'updateTestStatus',
      })
    }

    // Runtime metadata, not content authoring — no edit lock, same as
    // recordExecution; and the requirements the test verifies follow it.
    await db.transaction(async (tx) => {
      await this.writeLatestResult(tx, testCaseId, status, userId, undefined)
      await rollupVerificationForMasters(
        tx,
        await requirementMastersVerifiedBy(tx, [testCaseId]),
        { actorId: userId, cause: 'execution', testCaseId },
      )
    })
  }

  /**
   * Create VALIDATES relationships between a test case and parts.
   * Direction: TestCase → Part (source → target)
   * A test case "validates" a part/design element.
   */
  static async linkValidation(
    testCaseId: string,
    partIds: Array<string>,
    userId: string,
  ): Promise<void> {
    // Verify test case exists
    const testCase = await ItemService.findById(testCaseId)
    if (!testCase || testCase.itemType !== 'TestCase') {
      throw new NotFoundError('TestCase', testCaseId, {
        operation: 'linkValidation',
      })
    }

    // Create relationships for each part
    for (const partId of partIds) {
      const part = await ItemService.findById(partId)
      if (!part) {
        throw new NotFoundError('Part', partId, {
          operation: 'linkValidation',
        })
      }

      if (part.itemType !== 'Part') {
        throw new ValidationError(`Item ${partId} is not a Part`, undefined, {
          operation: 'linkValidation',
        })
      }

      // Check if relationship already exists
      const existing = await db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, testCaseId),
            eq(itemRelationships.targetId, partId),
            eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
          ),
        )
        .limit(1)

      if (existing.length === 0) {
        await ItemService.addRelationship(
          testCaseId,
          partId,
          VALIDATES_RELATIONSHIP,
          userId,
        )
      }
    }
  }

  /**
   * Remove a VALIDATES relationship between a test case and a part.
   */
  static async unlinkValidation(
    testCaseId: string,
    partId: string,
    userId: string,
  ): Promise<void> {
    // Find the relationship
    const [relationship] = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, testCaseId),
          eq(itemRelationships.targetId, partId),
          eq(itemRelationships.relationshipType, VALIDATES_RELATIONSHIP),
        ),
      )
      .limit(1)

    if (relationship) {
      await ItemService.removeRelationship(relationship.id, userId)
    }
  }

  /**
   * Get test cases that validate a part (VALIDATES relationships).
   */
  static async getValidatingTests(
    partId: string,
  ): Promise<Array<ValidatingTest>> {
    // VALIDATES belongs to the test case, so revising the part does not carry
    // it — read version-aware, like every other incoming link.
    const relationships =
      (
        await ItemRelationshipService.findIncomingLinks(
          [partId],
          VALIDATES_RELATIONSHIP,
        )
      ).get(partId) ?? []

    if (relationships.length === 0) {
      return []
    }

    // Get details for each test case
    const sourceIds = relationships.map((r) => r.sourceId)
    const testCaseItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
      })
      .from(items)
      .where(and(inArray(items.id, sourceIds), eq(items.itemType, 'TestCase')))

    // Get test case specific data
    const testCaseData = await db
      .select({
        itemId: testCases.itemId,
        testType: testCases.testType,
        executionStatus: testCases.executionStatus,
        lastExecutedAt: testCases.lastExecutedAt,
      })
      .from(testCases)
      .where(inArray(testCases.itemId, sourceIds))
    const states = await ItemRelationshipService.suspectStatesFor(
      relationships.map((r) => r.id),
    )

    // Combine data
    return testCaseItems.map((tc) => {
      const rel = relationships.find((r) => r.sourceId === tc.id)
      const tcData = testCaseData.find((t) => t.itemId === tc.id)
      return {
        id: tc.id,
        itemNumber: tc.itemNumber,
        name: tc.name,
        testType: tcData?.testType ?? null,
        executionStatus: tcData?.executionStatus ?? null,
        lastExecutedAt: tcData?.lastExecutedAt ?? null,
        relationshipId: rel!.id,
        ...suspectFields(states, rel!.id),
      }
    })
  }

  /**
   * Get parts that a test case validates (VALIDATES relationships).
   */
  static async getPartsValidatedBy(
    testCaseId: string,
  ): Promise<Array<ValidatedPart>> {
    // Targets resolve forward: a part revised since the link was made is
    // named by the row the release superseded.
    const relationships =
      (
        await ItemRelationshipService.findOutgoingLinks(
          [testCaseId],
          VALIDATES_RELATIONSHIP,
        )
      ).get(testCaseId) ?? []

    if (relationships.length === 0) {
      return []
    }

    // Get details for each part
    const targetIds = relationships.map((r) => r.targetId)
    const partItems = await db
      .select({
        id: items.id,
        itemNumber: items.itemNumber,
        name: items.name,
        state: items.state,
      })
      .from(items)
      .where(and(inArray(items.id, targetIds), eq(items.itemType, 'Part')))
    const states = await ItemRelationshipService.suspectStatesFor(
      relationships.map((r) => r.id),
    )

    // Combine data
    return partItems.map((part) => {
      const rel = relationships.find((r) => r.targetId === part.id)
      return {
        id: part.id,
        itemNumber: part.itemNumber,
        name: part.name,
        state: part.state,
        relationshipId: rel!.id,
        ...suspectFields(states, rel!.id),
      }
    })
  }
}
