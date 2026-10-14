// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Derived verification status.
 *
 * Data-integrity gate: a requirement's `verificationStatus` is the rollup of
 * the latest execution of every test case that verifies it, recomputed in
 * the transaction that records an execution or changes a verification link.
 * Pinned here:
 *
 * - after `recordExecution`, every requirement the test verifies reflects
 *   the latest executions, by the rule (Failed wins; Passed needs every test;
 *   any execution is InProgress; otherwise NotStarted), and a failing run
 *   flips its requirements with no manual step;
 * - linking and unlinking recompute, through the requirement service and
 *   through the generic relationship mutators alike;
 * - a waiver wins over the derivation and clearing it recomputes;
 * - the run is a fact on the bus (`test.executed`) and each status move is
 *   its own (`requirement.verification_changed`), in the same transaction;
 * - the one rule for "verified" holds across every coverage read, and a
 *   suspect verifying claim is not evidence;
 * - plan membership is read by the plan's master, within its design.
 *
 * The pure derivation is tabled at the top.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { and, eq } from 'drizzle-orm'
import { BranchService } from './BranchService'
import { CheckoutService } from './CheckoutService'
import { DesignService } from './DesignService'
import { GapAnalysisService } from './GapAnalysisService'
import { RequirementService } from './RequirementService'
import { VerificationService } from './VerificationService'
import { deriveVerificationStatus } from './verification-rollup'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { PersistedItem } from '@cascadia/commons/items/types/base'
import type { Requirement } from '@cascadia/commons/items/types/requirement'
import type { TestCase } from '@cascadia/commons/items/types/testcase'
import type { TestPlan } from '@cascadia/commons/items/types/testplan'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { takeFirst } from '@/db/take-first'
import { ItemService } from '@/items/services/ItemService'
import { ItemRelationshipService } from '@/items/services/ItemRelationshipService'
import { affirmationOf, withAffirmation } from '@/items/trace-affirmation'
import { VERIFIED_BY_RELATIONSHIP } from '@/items/traceability-relationships'
import {
  branchItems,
  domainEvents,
  itemRelationships,
  programMembers,
  programs,
  requirements,
  testCases,
} from '@/db/schema'
import '@/items/registerItemTypes.server'

describe('deriveVerificationStatus', () => {
  it.each([
    [[], 'NotStarted'],
    [[null], 'NotStarted'],
    [['NotRun'], 'NotStarted'],
    [['Passed'], 'Passed'],
    [['Passed', 'Passed'], 'Passed'],
    [['Passed', null], 'InProgress'],
    [['Blocked'], 'InProgress'],
    [['Passed', 'Blocked'], 'InProgress'],
    [['Failed'], 'Failed'],
    [['Passed', 'Failed'], 'Failed'],
    [['Failed', null], 'Failed'],
  ] as Array<[Array<string | null>, string]>)(
    'derives %j as %s',
    (results, expected) => {
      expect(deriveVerificationStatus(results)).toBe(expected)
    },
  )
})

describe('VerificationService — derived verification status', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let designId: string

  const uid = () =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Rollup Program',
          code: `PROG-${uid()}`,
          createdBy: user.id,
        })
        .returning(),
    )
    programId = program.id
    await testDb.db.insert(programMembers).values({
      programId,
      userId: user.id,
      role: 'admin',
      invitedBy: user.id,
    })
    designId = (
      await DesignService.create(
        {
          programId,
          name: 'Rollup Design',
          code: `DESIGN-${uid()}`,
          designType: 'Engineering',
        },
        user.id,
      )
    ).id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  const createRequirement = (overrides: Partial<Requirement> = {}) =>
    ItemService.create<Requirement>(
      'Requirement',
      {
        itemNumber: `REQ-${uid()}`,
        revision: 'A',
        designId,
        name: 'Requirement',
        ...overrides,
      } as Requirement,
      user.id,
    )

  const createTestCase = (overrides: Partial<TestCase> = {}) =>
    ItemService.create<TestCase>(
      'TestCase',
      {
        itemNumber: `TC-${uid()}`,
        revision: 'A',
        designId,
        name: 'Test Case',
        ...overrides,
      } as TestCase,
      user.id,
    )

  async function statusOf(requirementId: string): Promise<string | null> {
    const [row] = await testDb.db
      .select({ verificationStatus: requirements.verificationStatus })
      .from(requirements)
      .where(eq(requirements.itemId, requirementId))
    return row?.verificationStatus ?? null
  }

  async function eventsOfType(type: string) {
    return testDb.db
      .select({
        payload: domainEvents.payload,
        subjectId: domainEvents.subjectId,
      })
      .from(domainEvents)
      .where(eq(domainEvents.type, type))
  }

  it('a failing run flips every requirement the test verifies to Failed, with no manual step', async () => {
    const reqA = await createRequirement()
    const reqB = await createRequirement()
    const tc = await createTestCase()
    await RequirementService.linkVerification(reqA.id!, [tc.id!], user.id)
    await RequirementService.linkVerification(reqB.id!, [tc.id!], user.id)
    expect(await statusOf(reqA.id!)).toBe('NotStarted')

    await VerificationService.recordExecution(
      tc.id!,
      { status: 'Failed' },
      user.id,
    )
    expect(await statusOf(reqA.id!)).toBe('Failed')
    expect(await statusOf(reqB.id!)).toBe('Failed')

    // The latest run is what counts: a pass after the failure clears it.
    await VerificationService.recordExecution(
      tc.id!,
      { status: 'Passed' },
      user.id,
    )
    expect(await statusOf(reqA.id!)).toBe('Passed')
    expect(await statusOf(reqB.id!)).toBe('Passed')
  })

  it('needs every verifying test to pass; one unrun or blocked test keeps it InProgress', async () => {
    const req = await createRequirement()
    const first = await createTestCase()
    const second = await createTestCase()
    await RequirementService.linkVerification(
      req.id!,
      [first.id!, second.id!],
      user.id,
    )

    await VerificationService.recordExecution(
      first.id!,
      { status: 'Passed' },
      user.id,
    )
    expect(await statusOf(req.id!)).toBe('InProgress')

    await VerificationService.recordExecution(
      second.id!,
      { status: 'Blocked' },
      user.id,
    )
    expect(await statusOf(req.id!)).toBe('InProgress')

    await VerificationService.recordExecution(
      second.id!,
      { status: 'Passed' },
      user.id,
    )
    expect(await statusOf(req.id!)).toBe('Passed')

    // Unlinking the second test leaves the first's pass as the whole story.
    await VerificationService.recordExecution(
      second.id!,
      { status: 'Failed' },
      user.id,
    )
    expect(await statusOf(req.id!)).toBe('Failed')
    await RequirementService.unlinkVerification(req.id!, second.id!, user.id)
    expect(await statusOf(req.id!)).toBe('Passed')
  })

  it('a link made or removed through the generic relationship mutators recomputes too', async () => {
    const req = await createRequirement()
    const tc = await createTestCase()
    await VerificationService.recordExecution(
      tc.id!,
      { status: 'Passed' },
      user.id,
    )
    expect(await statusOf(req.id!)).toBe('NotStarted')

    // The Relationships tab's path, not the requirement's own endpoints.
    const edge = await ItemService.addRelationship(
      tc.id!,
      req.id!,
      VERIFIED_BY_RELATIONSHIP,
      user.id,
    )
    expect(await statusOf(req.id!)).toBe('Passed')

    await ItemService.removeRelationship(edge.id, user.id)
    expect(await statusOf(req.id!)).toBe('NotStarted')
  })

  it('a waiver wins over the derivation until it is cleared', async () => {
    const req = await createRequirement()
    const tc = await createTestCase()
    await RequirementService.linkVerification(req.id!, [tc.id!], user.id)
    await RequirementService.waiveVerification(
      req.id!,
      'Covered by qualification report QR-7',
      user.id,
    )
    expect(await statusOf(req.id!)).toBe('Waived')

    await VerificationService.recordExecution(
      tc.id!,
      { status: 'Failed' },
      user.id,
    )
    expect(await statusOf(req.id!)).toBe('Waived')

    const { status } = await RequirementService.clearVerificationWaiver(
      req.id!,
      user.id,
    )
    expect(status).toBe('Failed')
    expect(await statusOf(req.id!)).toBe('Failed')
  })

  it('records the run and each status move as facts in the same transaction', async () => {
    const req = await createRequirement()
    const tc = await createTestCase()
    await RequirementService.linkVerification(req.id!, [tc.id!], user.id)

    const execution = await VerificationService.recordExecution(
      tc.id!,
      { status: 'Passed' },
      user.id,
    )

    const runs = await eventsOfType('test.executed')
    expect(runs).toHaveLength(1)
    expect(runs[0]!.subjectId).toBe(tc.id)
    expect(runs[0]!.payload).toMatchObject({
      executionId: execution.id,
      testCaseId: tc.id,
      status: 'Passed',
      executedBy: user.id,
      requirementMasterIds: [req.masterId],
    })

    const moves = await eventsOfType('requirement.verification_changed')
    expect(moves.map((e) => e.payload)).toEqual([
      expect.objectContaining({
        requirementId: req.id,
        previousStatus: 'NotStarted',
        status: 'Passed',
        cause: 'execution',
        testCaseId: tc.id,
      }),
    ])

    // A run that moves nothing records the run and no move.
    await VerificationService.recordExecution(
      tc.id!,
      { status: 'Passed' },
      user.id,
    )
    expect(await eventsOfType('test.executed')).toHaveLength(2)
    expect(await eventsOfType('requirement.verification_changed')).toHaveLength(
      1,
    )
  })

  it('every coverage read agrees on verified, and a suspect verifying claim is not evidence', async () => {
    const req = await createRequirement({ priority: 'MustHave' })
    const tc = await createTestCase()
    await RequirementService.linkVerification(req.id!, [tc.id!], user.id)
    await VerificationService.recordExecution(
      tc.id!,
      { status: 'Passed' },
      user.id,
    )

    const verifiedEverywhere = async () => {
      const coverage = await RequirementService.getCoverage(designId)
      const tests = await VerificationService.getTestCoverage(designId)
      const analysis = await GapAnalysisService.analyze({ designId })
      return {
        coverage: coverage.verified,
        tests: tests.requirementsVerified,
        analysis: analysis.coverage.requirements.verified,
      }
    }
    expect(await verifiedEverywhere()).toEqual({
      coverage: 1,
      tests: 1,
      analysis: 1,
    })

    // The claim goes stale: its affirmation no longer names the row the edge
    // hangs off (the shape a revision leaves behind — pinned in the suspect
    // suite). The status still says Passed; nothing counts it.
    const [edge] = await testDb.db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, tc.id!),
          eq(itemRelationships.relationshipType, VERIFIED_BY_RELATIONSHIP),
        ),
      )
    await testDb.db
      .update(itemRelationships)
      .set({
        metadata: withAffirmation(edge!.metadata, {
          ...affirmationOf(edge!.metadata)!,
          sourceId: '00000000-0000-4000-8000-00000000dead',
        }),
      })
      .where(eq(itemRelationships.id, edge!.id))

    expect(await statusOf(req.id!)).toBe('Passed')
    expect(await verifiedEverywhere()).toEqual({
      coverage: 0,
      tests: 0,
      analysis: 0,
    })

    // Affirming the claim makes it evidence again, with no recompute.
    await ItemRelationshipService.affirmRelationship(edge!.id, user.id)
    expect(await verifiedEverywhere()).toEqual({
      coverage: 1,
      tests: 1,
      analysis: 1,
    })
  })

  it('a working copy minted on a branch carries the derived status and the waiver, and the rollup reaches it', async () => {
    const passed = await createRequirement()
    const waived = await createRequirement()
    const tc = await createTestCase()
    await RequirementService.linkVerification(passed.id!, [tc.id!], user.id)
    await VerificationService.recordExecution(
      tc.id!,
      { status: 'Passed' },
      user.id,
    )
    await RequirementService.waiveVerification(
      waived.id!,
      'Verified by similarity to the previous model',
      user.id,
    )

    // The first save on a change-order branch mints the working copy — the
    // path that used to rebuild the extension row through the handler's
    // insert, which takes no status from anyone.
    const changeOrder = await ItemService.create<PersistedItem>(
      'ChangeOrder',
      {
        revision: 'A',
        name: 'Rollup ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Carry the status',
        designId,
      } as unknown as PersistedItem,
      user.id,
    )
    const { branch } = await BranchService.getOrCreateChangeOrderBranch(
      designId,
      changeOrder.id,
      user.id,
    )
    const workingCopyOf = async (requirement: Requirement) => {
      await CheckoutService.checkout(
        { itemMasterId: requirement.masterId!, branchId: branch.id },
        user.id,
      )
      await CheckoutService.saveChanges(
        {
          branchId: branch.id,
          itemId: requirement.id!,
          changes: { description: 'Edited on the branch' },
          commitMessage: 'edit',
        },
        user.id,
      )
      const [row] = await testDb.db
        .select({ currentItemId: branchItems.currentItemId })
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, branch.id),
            eq(branchItems.itemMasterId, requirement.masterId!),
          ),
        )
      const copyId = row?.currentItemId
      if (!copyId || copyId === requirement.id) {
        throw new Error('the save should have minted a working copy')
      }
      return takeFirst(
        await testDb.db
          .select()
          .from(requirements)
          .where(eq(requirements.itemId, copyId)),
      )
    }

    const passedCopy = await workingCopyOf(passed)
    expect(passedCopy.verificationStatus).toBe('Passed')
    const waivedCopy = await workingCopyOf(waived)
    expect(waivedCopy.verificationStatus).toBe('Waived')
    expect(waivedCopy.verificationWaiver?.note).toBe(
      'Verified by similarity to the previous model',
    )

    // A run while the requirement is checked out moves main's row and the
    // working copy alike: both answer for the master.
    await VerificationService.recordExecution(
      tc.id!,
      { status: 'Failed' },
      user.id,
    )
    expect(await statusOf(passed.id!)).toBe('Failed')
    expect(await statusOf(passedCopy.itemId)).toBe('Failed')
  })

  it('lists a plan’s test cases by the plan’s master, within the plan’s design', async () => {
    const plan = await ItemService.create<TestPlan>(
      'TestPlan',
      {
        itemNumber: `TP-${uid()}`,
        revision: 'A',
        designId,
        name: 'Plan',
      } as TestPlan,
      user.id,
    )
    const member = await createTestCase({ testPlanId: plan.id })
    await createTestCase()

    // Stored as the plan's master, read back as the plan's row.
    const [stored] = await testDb.db
      .select({ testPlanMasterId: testCases.testPlanMasterId })
      .from(testCases)
      .where(eq(testCases.itemId, member.id!))
    expect(stored?.testPlanMasterId).toBe(plan.masterId)
    expect(
      ((await ItemService.findById(member.id!)) as TestCase).testPlanId,
    ).toBe(plan.id)

    // A test case in another design that still names this master — the
    // shape a copy leaves behind — is that design's business.
    const elsewhere = await DesignService.create(
      {
        programId,
        name: 'Other Design',
        code: `DESIGN-${uid()}`,
        designType: 'Engineering',
      },
      user.id,
    )
    const stray = await createTestCase({ designId: elsewhere.id })
    await testDb.db
      .update(testCases)
      .set({ testPlanMasterId: plan.masterId })
      .where(eq(testCases.itemId, stray.id!))

    const listed = await VerificationService.getTestCasesForPlan(plan.id!)
    expect(listed.map((tc) => tc.id)).toEqual([member.id])
  })
})
