// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The requirements traceability matrix at a version context.
 *
 * Complex-algorithm gate: the matrix resolves both ends of every claim to
 * the rows that answer for them at the context, and that resolution is
 * where a wrong answer looks exactly like a right one. Pinned here:
 *
 * - the released view agrees with the coverage read, row for row;
 * - a tag taken before a revision is the compliance snapshot: the old
 *   graph, un-suspect, while main shows the carried claim suspect;
 * - a branch shows its working copy's claims, and nowhere else does;
 * - the program rollup is the sum of the designs' matrices.
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
import { and, eq, isNotNull } from 'drizzle-orm'
import { ItemService } from '../items/services/ItemService'
import { ChangeOrderService } from '../items/services/ChangeOrderService'
import { ItemRelationshipService } from '../items/services/ItemRelationshipService'
import { BranchService } from './BranchService'
import { ChangeOrderMergeService } from './ChangeOrderMergeService'
import { CheckoutService } from './CheckoutService'
import { DesignService } from './DesignService'
import { RequirementService } from './RequirementService'
import { RequirementsMatrixService } from './RequirementsMatrixService'
import { VerificationService } from './VerificationService'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { PersistedItem } from '@cascadia/commons/items/types/base'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  seedRequirementLifecycle,
  seedStandardPartLifecycle,
} from '@/__tests__/fixtures/lifecycles'
import {
  branchItems,
  changeOrderDesigns,
  items,
  lifecycleDefinitions,
  lifecycleInstances,
  programMembers,
  programs,
  tags,
} from '@/db/schema'
import { itemVersions } from '@/db/schema/versioning'
import { takeFirst } from '@/db/take-first'
import { ItemTypeRegistry } from '@/items/registry'
import '@/items/registerItemTypes.server'

// Unique to this file, so it cannot race another suite's ECO workflow.
const WORKFLOW_ID = '00000000-0000-4000-8000-000000000242'

describe('RequirementsMatrixService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let designId: string
  let initialCommitId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
    await seedRequirementLifecycle(testDb.db)
    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: WORKFLOW_ID,
        name: 'Test ECO Workflow - RequirementsMatrix',
        version: 1,
        workflowType: 'strict',
        definition: {
          states: [
            { id: 'Draft', name: 'Draft', isInitial: true, isFinal: false },
            {
              id: 'Approved',
              name: 'Approved',
              isInitial: false,
              isFinal: false,
            },
            {
              id: 'Released',
              name: 'Released',
              isInitial: false,
              isFinal: true,
              finalKind: 'release',
            },
          ],
          transitions: [
            {
              id: 't1',
              name: 'Approve',
              fromStateId: 'Draft',
              toStateId: 'Approved',
            },
            {
              id: 't2',
              name: 'Release',
              fromStateId: 'Approved',
              toStateId: 'Released',
            },
          ],
          applicableItemTypes: ['ChangeOrder'],
        },
        isActive: true,
        lifecycleType: 'Driving',
      })
      .onConflictDoNothing()
    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    uniquePrefix = `M${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Matrix Program',
          code: `PROG-${uniquePrefix}`,
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
    const design = await DesignService.create(
      {
        programId,
        name: 'Matrix Design',
        code: `DESIGN-${uniquePrefix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id
    initialCommitId = design.initialCommit!.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  // ---- Fixtures (the shape the suspect-links suite uses) ----

  async function createPart(suffix: string): Promise<PersistedItem> {
    return ItemService.create<PersistedItem>(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-${suffix}`,
        revision: 'A',
        name: `Part ${suffix}`,
        designId,
      } as PersistedItem,
      user.id,
    )
  }

  async function createRequirement(suffix: string): Promise<PersistedItem> {
    return ItemService.create<PersistedItem>(
      'Requirement',
      {
        itemNumber: `REQ-${uniquePrefix}-${suffix}`,
        revision: 'A',
        name: `Requirement ${suffix}`,
        designId,
        priority: 'MustHave',
      } as unknown as PersistedItem,
      user.id,
    )
  }

  async function createTestCase(suffix: string): Promise<PersistedItem> {
    return ItemService.create<PersistedItem>(
      'TestCase',
      {
        itemNumber: `TC-${uniquePrefix}-${suffix}`,
        revision: 'A',
        name: `Test ${suffix}`,
        designId,
      } as PersistedItem,
      user.id,
    )
  }

  /** The row becomes the released baseline and the initial commit names it. */
  async function releaseOnMain(item: PersistedItem): Promise<void> {
    await testDb.db
      .update(items)
      .set({ state: 'Released', isCurrent: true })
      .where(eq(items.id, item.id))
    await testDb.db.insert(itemVersions).values({
      commitId: initialCommitId,
      itemId: item.id,
      changeType: 'added',
    })
  }

  async function releasedSatisfactionClaim(suffix: string) {
    const part = await createPart(suffix)
    const requirement = await createRequirement(suffix)
    await RequirementService.linkSatisfaction(
      requirement.id,
      [part.id],
      user.id,
    )
    await releaseOnMain(part)
    await releaseOnMain(requirement)
    return { part, requirement }
  }

  async function createChangeOrder(): Promise<PersistedItem> {
    const changeOrder = await ItemService.create<PersistedItem>(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Matrix ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Revise one end of a trace link',
      } as unknown as PersistedItem,
      user.id,
    )
    await testDb.db.insert(lifecycleInstances).values({
      workflowDefinitionId: WORKFLOW_ID,
      itemId: changeOrder.id,
      currentState: 'Draft',
    })
    return changeOrder
  }

  /** Check `item` out to a fresh change order and edit it there. */
  async function reviseInChangeOrder(item: PersistedItem) {
    const changeOrder = await createChangeOrder()
    const { branch } = await BranchService.getOrCreateChangeOrderBranch(
      designId,
      changeOrder.id,
      user.id,
    )
    await testDb.db.insert(changeOrderDesigns).values({
      changeOrderId: changeOrder.id,
      designId,
      branchId: branch.id,
      mergeStatus: 'pending',
    })
    const mainBranch = await BranchService.getMainBranch(designId)
    await testDb.db.insert(branchItems).values({
      branchId: mainBranch!.id,
      itemMasterId: item.masterId,
      currentItemId: item.id,
      baseItemId: item.id,
      changeType: null,
    })
    await CheckoutService.checkout(
      { itemMasterId: item.masterId, branchId: branch.id },
      user.id,
    )
    await CheckoutService.saveChanges(
      {
        branchId: branch.id,
        itemId: item.id,
        changes: { name: 'Revised on the ECO branch' },
        commitMessage: 'revise',
      },
      user.id,
    )
    const [row] = await testDb.db
      .select({ currentItemId: branchItems.currentItemId })
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branch.id),
          eq(branchItems.itemMasterId, item.masterId),
        ),
      )
      .limit(1)
    return {
      changeOrder,
      branchId: branch.id,
      workingCopyId: row!.currentItemId!,
    }
  }

  /** Approve (skipping the workflow, as the merge suite does) and merge. */
  async function release(changeOrder: PersistedItem): Promise<void> {
    for (const changeOrderDesign of await ChangeOrderService.getChangeOrderDesigns(
      changeOrder.id,
    )) {
      if (!changeOrderDesign.branchId) continue
      const branchRows = await testDb.db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, changeOrderDesign.branchId),
            isNotNull(branchItems.changeType),
          ),
        )
      for (const row of branchRows) {
        await ChangeOrderService.registerBranchChange(
          changeOrderDesign.branchId,
          row.itemMasterId,
          row.currentItemId,
          user.id,
        )
      }
    }
    await testDb.db
      .update(items)
      .set({ state: 'Approved' })
      .where(eq(items.id, changeOrder.id))
    await testDb.db
      .update(lifecycleInstances)
      .set({ currentState: 'Approved' })
      .where(eq(lifecycleInstances.itemId, changeOrder.id))
    await ChangeOrderMergeService.merge(changeOrder.id, user.id)
  }

  /** A tag naming main's head as it stands now. */
  async function tagMain(name: string): Promise<string> {
    const mainBranch = await BranchService.getMainBranch(designId)
    return takeFirst(
      await testDb.db
        .insert(tags)
        .values({
          designId,
          name: `${uniquePrefix}-${name}`,
          commitId: mainBranch!.headCommitId!,
          createdBy: user.id,
        })
        .returning({ id: tags.id }),
    ).id
  }

  const released = () => ({ type: 'released' as const, designId })

  // ---- Cases ----

  it('the released view agrees with the coverage read, and lists both ends of every claim', async () => {
    // Pre-release, so main is open to every link; the released view reads
    // the current rows either way.
    const part = await createPart('covered')
    const requirement = await createRequirement('covered')
    const test = await createTestCase('covered')
    await RequirementService.linkSatisfaction(
      requirement.id,
      [part.id],
      user.id,
    )
    await RequirementService.linkVerification(
      requirement.id,
      [test.id],
      user.id,
    )
    await VerificationService.recordExecution(
      test.id,
      { status: 'Passed' },
      user.id,
    )
    const bare = await createRequirement('bare')

    const matrix = await RequirementsMatrixService.forDesign(
      designId,
      released(),
    )
    expect(matrix.context).toEqual({ type: 'released', id: null })
    expect(matrix.totals).toEqual({
      total: 2,
      allocated: 0,
      satisfied: 1,
      verified: 1,
      suspect: 0,
      gaps: { not_allocated: 2, not_satisfied: 1, not_verified: 1 },
    })

    const covered = matrix.rows.find((r) => r.requirement.id === requirement.id)
    expect(covered?.satisfiedBy.map((l) => l.itemId)).toEqual([part.id])
    expect(covered?.verifiedBy).toMatchObject([
      { itemId: test.id, executionStatus: 'Passed', suspect: false },
    ])
    expect(covered?.verified).toBe(true)
    expect(covered?.requirement.verificationStatus).toBe('Passed')
    expect(covered?.gaps).toEqual(['not_allocated'])

    const empty = matrix.rows.find((r) => r.requirement.id === bare.id)
    expect(empty?.gaps).toEqual([
      'not_allocated',
      'not_satisfied',
      'not_verified',
    ])

    const coverage = await RequirementService.getCoverage(designId)
    expect([
      coverage.totalRequirements,
      coverage.satisfied,
      coverage.verified,
      coverage.suspect,
    ]).toEqual([
      matrix.totals.total,
      matrix.totals.satisfied,
      matrix.totals.verified,
      matrix.totals.suspect,
    ])

    const rollup = await RequirementsMatrixService.forProgram(programId)
    expect(rollup.designs).toMatchObject([
      { designId, total: 2, satisfied: 1, verified: 1 },
    ])
    expect(rollup.totals).toEqual(matrix.totals)
    expect(rollup.openGapsTotal).toBe(4)
    expect(rollup.openGaps[0]).toMatchObject({
      designId,
      gapType: 'not_allocated',
    })
  })

  it('a tag taken before a revision is the compliance snapshot: the old graph, un-suspect, while main shows the claim suspect', async () => {
    const { part, requirement } = await releasedSatisfactionClaim('baseline')
    const tagId = await tagMain('PDR')

    const { changeOrder } = await reviseInChangeOrder(requirement)
    await release(changeOrder)

    const atMain = await RequirementsMatrixService.forDesign(
      designId,
      released(),
    )
    expect(atMain.rows).toHaveLength(1)
    const revised = atMain.rows[0]!
    expect(revised.requirement.id).not.toBe(requirement.id)
    expect(revised.requirement.revision).toBe('B')
    expect(revised.satisfiedBy).toMatchObject([
      {
        itemId: part.id,
        suspect: true,
        suspectReasons: ['target_revised'],
      },
    ])
    expect(revised.suspectCount).toBe(1)
    expect(atMain.totals.suspect).toBe(1)

    const atTag = await RequirementsMatrixService.forDesign(designId, {
      type: 'tag',
      tagId,
    })
    expect(atTag.context).toEqual({ type: 'tag', id: tagId })
    expect(atTag.rows).toHaveLength(1)
    const baseline = atTag.rows[0]!
    expect(baseline.requirement.id).toBe(requirement.id)
    expect(baseline.requirement.revision).toBe('A')
    expect(baseline.satisfiedBy).toMatchObject([
      { itemId: part.id, suspect: false, suspectReasons: [] },
    ])
    expect(atTag.totals.suspect).toBe(0)

    // Affirming the carried claim on main re-affirms it against rev B. That
    // clears main, and it does not make the baseline suspect in hindsight:
    // at the tag the claim is affirmed against a later revision of the row
    // the tag holds, which is the best a snapshot can know.
    await ItemRelationshipService.affirmRelationship(
      revised.satisfiedBy[0]!.relationshipId,
      user.id,
    )
    const mainAfter = await RequirementsMatrixService.forDesign(
      designId,
      released(),
    )
    expect(mainAfter.rows[0]!.satisfiedBy[0]).toMatchObject({ suspect: false })
    const tagAfter = await RequirementsMatrixService.forDesign(designId, {
      type: 'tag',
      tagId,
    })
    expect(tagAfter.rows[0]!.satisfiedBy[0]).toMatchObject({ suspect: false })
  })

  it("a branch shows its working copy's claims, and the released view does not", async () => {
    const { part, requirement } = await releasedSatisfactionClaim('branched')
    const { branchId, workingCopyId } = await reviseInChangeOrder(part)

    const onBranch = await RequirementsMatrixService.forDesign(designId, {
      type: 'branch',
      branchId,
    })
    expect(onBranch.context).toEqual({ type: 'branch', id: branchId })
    const branchRow = onBranch.rows.find(
      (r) => r.requirement.id === requirement.id,
    )
    // The copy is a new row the branch answers with, carrying a claim
    // affirmed against the released one — suspect until affirmed there.
    expect(branchRow?.satisfiedBy).toMatchObject([
      {
        itemId: workingCopyId,
        suspect: true,
        suspectReasons: ['source_revised'],
      },
    ])

    const onMain = await RequirementsMatrixService.forDesign(
      designId,
      released(),
    )
    const mainRow = onMain.rows.find((r) => r.requirement.id === requirement.id)
    expect(mainRow?.satisfiedBy).toMatchObject([
      { itemId: part.id, suspect: false },
    ])
    expect(onMain.totals.suspect).toBe(0)
  })
})
