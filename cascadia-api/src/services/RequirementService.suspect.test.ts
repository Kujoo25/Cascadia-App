// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Suspect links through a real change-order cycle.
 *
 * Data-integrity gate: a traceability claim is only as good as the versions
 * it was affirmed against, and the two places that move an edge between
 * versions — the checkout copy and the merge rebuild — must carry that
 * affirmation correctly or the flag lies in one direction or the other.
 * Invariants pinned here:
 *
 * - revising the **target** makes every claim affirmed against the old row
 *   suspect, and affirming clears it, with no write to the claim's source;
 * - a claim carried onto a working copy is suspect on the branch, and a
 *   release carries an affirmation made there onto the released row — the
 *   edge's metadata survives the merge;
 * - a claim nobody looked at on the branch is released suspect, not laundered.
 *
 * The arithmetic itself is pinned in `items/trace-affirmation.test.ts`.
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
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { ItemService } from '../items/services/ItemService'
import { ChangeOrderService } from '../items/services/ChangeOrderService'
import { ItemRelationshipService } from '../items/services/ItemRelationshipService'
import { affirmationOf } from '../items/trace-affirmation'
import { followSupersededRows } from '../items/version-lineage'
import { ValidationError } from '../errors'
import { ChangeOrderMergeService } from './ChangeOrderMergeService'
import { BranchService } from './BranchService'
import { CheckoutService } from './CheckoutService'
import { ConflictDetectionService } from './ConflictDetectionService'
import { DesignService } from './DesignService'
import { GapAnalysisService } from './GapAnalysisService'
import { RequirementService } from './RequirementService'
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
  itemRelationships,
  items,
  lifecycleDefinitions,
  lifecycleInstances,
  programMembers,
  programs,
} from '@/db/schema'
import { itemVersions } from '@/db/schema/versioning'
import { takeFirst } from '@/db/take-first'
import { ItemTypeRegistry } from '@/items/registry'
import '@/items/registerItemTypes.server'

// Unique to this file, so it cannot race another suite's ECO workflow.
const WORKFLOW_ID = '00000000-0000-4000-8000-000000000241'

describe('RequirementService — suspect links', () => {
  const testDb = new TestDatabase()
  let user: TestUser
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
        name: 'Test ECO Workflow - SuspectLinks',
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
    uniquePrefix = `S${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Suspect Links Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )
    await testDb.db.insert(programMembers).values({
      programId: program.id,
      userId: user.id,
      role: 'admin',
      invitedBy: user.id,
    })

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Suspect Links Design',
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

  // ---- Fixtures ----

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
      } as PersistedItem,
      user.id,
    )
  }

  /**
   * Release an item on main the way the other suites do: the row becomes the
   * released baseline and the initial commit names it, so VersionResolver
   * finds it. Done after linking, because once anything in the design has
   * released, main is protected and the links themselves would be refused.
   */
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

  /** A part and a requirement, linked, then both released on main. */
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
        name: 'Suspect Links ECO',
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

  /**
   * Check `item` out to a fresh change order and edit it there, so the
   * release will mint a new revision of it.
   */
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

    // Main tracks the released row, the way a design's main branch does
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

  /** The row that now answers for a master on main. */
  async function currentRowOf(masterId: string): Promise<string> {
    const [row] = await testDb.db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.masterId, masterId), eq(items.isCurrent, true)))
      .limit(1)
    return row!.id
  }

  async function satisfiesEdgeFrom(sourceId: string) {
    const [edge] = await testDb.db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, sourceId),
          eq(itemRelationships.relationshipType, 'SATISFIES'),
        ),
      )
      .limit(1)
    return edge!
  }

  // ---- Target side ----

  it('a new claim is affirmed by its author against the rows it names', async () => {
    const { part, requirement } = await releasedSatisfactionClaim('born')

    expect(
      affirmationOf((await satisfiesEdgeFrom(part.id)).metadata),
    ).toMatchObject({
      sourceId: part.id,
      targetId: requirement.id,
      affirmedBy: user.id,
    })

    const listed = await RequirementService.getSatisfyingItems(requirement.id)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: part.id,
      suspect: false,
      suspectReasons: [],
    })
  })

  it('revising the requirement makes the claim suspect from both ends, until affirmed', async () => {
    const { part, requirement } = await releasedSatisfactionClaim('target')

    const { changeOrder } = await reviseInChangeOrder(requirement)
    await release(changeOrder)
    const revised = await currentRowOf(requirement.masterId)
    expect(revised).not.toBe(requirement.id)

    // The claim was inherited by the new revision — and it is suspect there.
    const fromRequirement = await RequirementService.getSatisfyingItems(revised)
    expect(fromRequirement).toHaveLength(1)
    expect(fromRequirement[0]).toMatchObject({
      id: part.id,
      suspect: true,
      suspectReasons: ['target_revised'],
    })

    // Seen from the part, the same link, resolved forward, is suspect too.
    const fromPart = await RequirementService.getRequirementsSatisfiedBy(
      part.id,
    )
    expect(fromPart).toHaveLength(1)
    expect(fromPart[0]).toMatchObject({
      id: revised,
      suspect: true,
      suspectReasons: ['target_revised'],
    })

    // Affirming needs no checkout of the part, which is released on
    // protected main: it is a review record, not an edit of the link.
    const { state } = await ItemRelationshipService.affirmRelationship(
      fromRequirement[0]!.relationshipId,
      user.id,
    )
    expect(state).toMatchObject({ suspect: false, reasons: [] })
    expect(state.affirmation).toMatchObject({
      sourceId: part.id,
      targetId: revised,
      affirmedBy: user.id,
    })

    expect(
      (await RequirementService.getSatisfyingItems(revised))[0],
    ).toMatchObject({ suspect: false, suspectReasons: [] })
    expect(
      (await RequirementService.getRequirementsSatisfiedBy(part.id))[0],
    ).toMatchObject({ suspect: false, suspectReasons: [] })

    // The pin itself was left where it pointed; readers resolve it anyway.
    expect((await satisfiesEdgeFrom(part.id)).targetId).toBe(requirement.id)
  })

  // ---- Source side ----

  it('a claim carried onto a working copy is suspect on the branch, and releases affirmed once affirmed there', async () => {
    const { part, requirement } = await releasedSatisfactionClaim('source')

    const { changeOrder, workingCopyId } = await reviseInChangeOrder(part)

    const onBranch =
      await RequirementService.getRequirementsSatisfiedBy(workingCopyId)
    expect(onBranch).toHaveLength(1)
    expect(onBranch[0]).toMatchObject({
      id: requirement.id,
      suspect: true,
      suspectReasons: ['source_revised'],
    })
    // Main's own claim is untouched by the branch.
    expect(
      (await RequirementService.getRequirementsSatisfiedBy(part.id))[0],
    ).toMatchObject({ suspect: false })

    await ItemRelationshipService.affirmRelationship(
      onBranch[0]!.relationshipId,
      user.id,
    )
    expect(
      (await RequirementService.getRequirementsSatisfiedBy(workingCopyId))[0],
    ).toMatchObject({ suspect: false, suspectReasons: [] })

    await release(changeOrder)
    const released = await currentRowOf(part.masterId)
    expect(released).not.toBe(part.id)

    const afterRelease =
      await RequirementService.getRequirementsSatisfiedBy(released)
    expect(afterRelease).toHaveLength(1)
    expect(afterRelease[0]).toMatchObject({
      id: requirement.id,
      suspect: false,
      suspectReasons: [],
    })

    // The merge re-homed the edge AND its metadata: the affirmation made on
    // the working copy now names the released row.
    expect(
      affirmationOf((await satisfiesEdgeFrom(released)).metadata),
    ).toMatchObject({
      sourceId: released,
      targetId: requirement.id,
      affirmedBy: user.id,
    })
  })

  it('a claim nobody looked at on the branch is released suspect, not laundered', async () => {
    const { part, requirement } = await releasedSatisfactionClaim('unseen')

    const { changeOrder } = await reviseInChangeOrder(part)
    await release(changeOrder)
    const released = await currentRowOf(part.masterId)

    const afterRelease =
      await RequirementService.getRequirementsSatisfiedBy(released)
    expect(afterRelease[0]).toMatchObject({
      id: requirement.id,
      suspect: true,
      suspectReasons: ['source_revised'],
    })
    // Still affirmed against the row the release superseded — which is
    // exactly what makes it suspect.
    expect(
      affirmationOf((await satisfiesEdgeFrom(released)).metadata),
    ).toMatchObject({
      sourceId: part.id,
      targetId: requirement.id,
    })
  })

  it("the merge carries an edge's SysML and cross-design columns onto the released row", async () => {
    const { part, requirement } = await releasedSatisfactionClaim('columns')
    const { changeOrder, workingCopyId } = await reviseInChangeOrder(part)

    // Set on the branch, the way a usage copy or a cross-reference pull-in
    // sets them; until 2026-10-09 the release reset every one of these.
    await testDb.db
      .update(itemRelationships)
      .set({
        isComposite: true,
        isDirected: false,
        multiplicityLower: 0,
        multiplicityUpper: 5,
        usageAttributes: { role: 'primary' },
        sourceDomain: 'engineering',
        targetDomain: 'engineering',
        derivationMethod: 'direct',
        derivationNotes: 'carried through the release',
      })
      .where(
        and(
          eq(itemRelationships.sourceId, workingCopyId),
          eq(itemRelationships.relationshipType, 'SATISFIES'),
        ),
      )

    await release(changeOrder)
    const released = await currentRowOf(part.masterId)

    expect(await satisfiesEdgeFrom(released)).toMatchObject({
      targetId: requirement.id,
      isComposite: true,
      isDirected: false,
      multiplicityLower: 0,
      multiplicityUpper: 5,
      usageAttributes: { role: 'primary' },
      sourceDomain: 'engineering',
      targetDomain: 'engineering',
      derivationMethod: 'direct',
      derivationNotes: 'carried through the release',
    })
  })

  it('an affirmation made on the branch survives a rebase and a pull from main', async () => {
    const { part, requirement } = await releasedSatisfactionClaim('rebase')
    const { branchId, workingCopyId } = await reviseInChangeOrder(part)

    const onBranch =
      await RequirementService.getRequirementsSatisfiedBy(workingCopyId)
    await ItemRelationshipService.affirmRelationship(
      onBranch[0]!.relationshipId,
      user.id,
    )

    // Main moves on underneath the branch: another release minted rev B of
    // the part, which is what a rebase and a pull bring in. Same content as
    // rev A, so the branch's own edit merges without a field conflict.
    const newBase = takeFirst(
      await testDb.db
        .insert(items)
        .values({
          masterId: part.masterId,
          designId,
          itemType: 'Part',
          itemNumber: part.itemNumber,
          revision: 'B',
          name: part.name,
          state: 'Released',
          isCurrent: false,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning(),
    )
    const branchItem = takeFirst(
      await testDb.db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, branchId),
            eq(branchItems.itemMasterId, part.masterId),
          ),
        ),
    )

    const rebased = await ConflictDetectionService.rebaseItem(
      branchItem.id,
      newBase.id,
      user.id,
    )
    expect(rebased.success).toBe(true)
    const afterRebase = takeFirst(
      await testDb.db
        .select({ currentItemId: branchItems.currentItemId })
        .from(branchItems)
        .where(eq(branchItems.id, branchItem.id)),
    )
    expect(
      await RequirementService.getRequirementsSatisfiedBy(
        afterRebase.currentItemId!,
      ),
    ).toMatchObject([
      { id: requirement.id, suspect: false, suspectReasons: [] },
    ])

    const pulled = await ConflictDetectionService.pullChangesFromMain(
      branchItem.id,
      newBase.id,
      user.id,
    )
    expect(pulled.success).toBe(true)
    expect(
      await RequirementService.getRequirementsSatisfiedBy(pulled.newItemId!),
    ).toMatchObject([
      { id: requirement.id, suspect: false, suspectReasons: [] },
    ])
  })

  it('a copy that continues a working copy carries its affirmation; a copy off a released row does not', async () => {
    const { part, requirement } = await releasedSatisfactionClaim('copy')
    const { branchId, workingCopyId } = await reviseInChangeOrder(part)
    await ItemRelationshipService.affirmRelationship(
      (await RequirementService.getRequirementsSatisfiedBy(workingCopyId))[0]!
        .relationshipId,
      user.id,
    )

    // A fresh working row of the same master, the shape a rebase mints when
    // it cannot write the working copy in place. The marker is any branch
    // placeholder other than this branch's own.
    expect(branchId.slice(0, 8)).not.toBe('c0000001')
    const continued = takeFirst(
      await testDb.db
        .insert(items)
        .values({
          masterId: part.masterId,
          designId,
          itemType: 'Part',
          itemNumber: part.itemNumber,
          revision: '-c0000001',
          name: 'Continued working copy',
          state: 'Draft',
          isCurrent: false,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning(),
    )
    await ItemRelationshipService.copyRelationshipsToItem({
      sourceItemId: workingCopyId,
      targetItemId: continued.id,
      userId: user.id,
    })
    expect(
      affirmationOf((await satisfiesEdgeFrom(continued.id)).metadata),
    ).toMatchObject({ sourceId: continued.id, targetId: requirement.id })

    // Off the released row the affirmation stays put — that copy is a
    // checkout, and its claim is for the person changing the item to affirm.
    const checkedOut = takeFirst(
      await testDb.db
        .insert(items)
        .values({
          masterId: part.masterId,
          designId,
          itemType: 'Part',
          itemNumber: part.itemNumber,
          revision: '-c0000002',
          name: 'Checked out again',
          state: 'Draft',
          isCurrent: false,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning(),
    )
    await ItemRelationshipService.copyRelationshipsToItem({
      sourceItemId: part.id,
      targetItemId: checkedOut.id,
      userId: user.id,
    })
    expect(
      affirmationOf((await satisfiesEdgeFrom(checkedOut.id)).metadata),
    ).toMatchObject({ sourceId: part.id, targetId: requirement.id })
  })

  it('a claim that predates affirmations is suspect once its source is checked out, and releases as any other', async () => {
    const part = await createPart('legacy-src')
    const requirement = await createRequirement('legacy-src')
    // The shape every link had before affirmations existed: no metadata.
    await testDb.db.insert(itemRelationships).values({
      sourceId: part.id,
      targetId: requirement.id,
      relationshipType: 'SATISFIES',
      createdBy: user.id,
    })
    await releaseOnMain(part)
    await releaseOnMain(requirement)
    expect(
      (await RequirementService.getRequirementsSatisfiedBy(part.id))[0],
    ).toMatchObject({ suspect: false })

    // Checked out, the copy carries the reading main gave the edge — the
    // released row, by its author — and is suspect for the same reason a
    // claim born affirmed is: the row it hangs off is not the one affirmed.
    const { changeOrder, workingCopyId } = await reviseInChangeOrder(part)
    const onBranch =
      await RequirementService.getRequirementsSatisfiedBy(workingCopyId)
    expect(onBranch[0]).toMatchObject({
      id: requirement.id,
      suspect: true,
      suspectReasons: ['source_revised'],
    })
    expect(
      affirmationOf((await satisfiesEdgeFrom(workingCopyId)).metadata),
    ).toMatchObject({
      sourceId: part.id,
      targetId: requirement.id,
      affirmedBy: user.id,
    })
    // Main's own edge is left as it was.
    expect(affirmationOf((await satisfiesEdgeFrom(part.id)).metadata)).toBe(
      null,
    )

    // And the release preview counts it, as it counts any other.
    const { preview } = await previewTuples(changeOrder.id)
    expect(preview.traceImpact.suspectAfterRelease).toBe(1)

    await release(changeOrder)
    const released = await currentRowOf(part.masterId)
    expect(
      (await RequirementService.getRequirementsSatisfiedBy(released))[0],
    ).toMatchObject({ suspect: true, suspectReasons: ['source_revised'] })
  })

  // ---- The release preview ----

  /** One trace claim, named the way both the preview and a reader name it. */
  interface ClaimTuple {
    relationshipType: string
    source: string
    target: string
    reasons: Array<string>
  }

  function previewTuples(changeOrderId: string) {
    return ChangeOrderMergeService.previewMerge(changeOrderId).then(
      (preview) => ({
        preview,
        tuples: preview.traceImpact.links
          .map((link) => ({
            relationshipType: link.relationshipType,
            source: link.source.itemNumber,
            target: link.target.itemNumber,
            reasons: link.reasons,
          }))
          .sort(byTuple),
      }),
    )
  }

  /**
   * The suspect claims touching the current rows of `masterIds` after a
   * release, read the way every trace listing reads them: the rows' own
   * outgoing claims, and the incoming ones resolved through the lineage.
   */
  async function suspectClaimsTouching(
    masterIds: Array<string>,
  ): Promise<Array<ClaimTuple>> {
    const currentIds = await Promise.all(masterIds.map(currentRowOf))
    const edges = new Map<string, typeof itemRelationships.$inferSelect>()
    for (const rel of await testDb.db
      .select()
      .from(itemRelationships)
      .where(inArray(itemRelationships.sourceId, currentIds))) {
      edges.set(rel.id, rel)
    }
    for (const relationshipType of ['SATISFIES', 'VERIFIED_BY', 'VALIDATES']) {
      const incoming = await ItemRelationshipService.findIncomingLinks(
        currentIds,
        relationshipType,
      )
      for (const rels of incoming.values()) {
        for (const rel of rels) edges.set(rel.id, rel)
      }
    }
    const states = await ItemRelationshipService.suspectStatesFor([
      ...edges.keys(),
    ])
    const redirects = await followSupersededRows(
      [...edges.values()].map((rel) => rel.targetId),
    )
    const numberOf = async (id: string) =>
      (
        await testDb.db
          .select({ itemNumber: items.itemNumber })
          .from(items)
          .where(eq(items.id, id))
      )[0]!.itemNumber

    const tuples: Array<ClaimTuple> = []
    for (const rel of edges.values()) {
      const state = states.get(rel.id)
      if (!state?.suspect) continue
      tuples.push({
        relationshipType: rel.relationshipType,
        source: await numberOf(rel.sourceId),
        target: await numberOf(redirects.get(rel.targetId) ?? rel.targetId),
        reasons: state.reasons,
      })
    }
    return tuples.sort(byTuple)
  }

  function byTuple(a: ClaimTuple, b: ClaimTuple): number {
    return (
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target) ||
      a.relationshipType.localeCompare(b.relationshipType)
    )
  }

  it('the preview counts a claim nobody affirmed on the branch as suspect after release, and the merge agrees', async () => {
    const { part, requirement } = await releasedSatisfactionClaim('pv-src')
    const { changeOrder } = await reviseInChangeOrder(part)

    const { preview, tuples } = await previewTuples(changeOrder.id)
    expect(preview.traceImpact).toMatchObject({
      suspectAfterRelease: 1,
      newlySuspect: 1,
    })
    expect(tuples).toEqual([
      {
        relationshipType: 'SATISFIES',
        source: part.itemNumber,
        target: requirement.itemNumber,
        reasons: ['source_revised'],
      },
    ])
    expect(preview.traceImpact.links[0]).toMatchObject({
      alreadySuspect: false,
    })

    await release(changeOrder)
    expect(await suspectClaimsTouching([part.masterId])).toEqual(tuples)
  })

  it('the preview counts every claim affirmed against the row a release supersedes, and the merge agrees', async () => {
    // Linked before anything releases, since main is protected afterwards.
    const part = await createPart('pv-tgt')
    const requirement = await createRequirement('pv-tgt')
    const testCase = await ItemService.create<PersistedItem>(
      'TestCase',
      {
        itemNumber: `TC-${uniquePrefix}-pv-tgt`,
        revision: 'A',
        name: 'Static load test',
        designId,
      } as PersistedItem,
      user.id,
    )
    await RequirementService.linkSatisfaction(
      requirement.id,
      [part.id],
      user.id,
    )
    await RequirementService.linkVerification(
      requirement.id,
      [testCase.id],
      user.id,
    )
    await releaseOnMain(part)
    await releaseOnMain(requirement)
    const { changeOrder } = await reviseInChangeOrder(requirement)

    const { preview, tuples } = await previewTuples(changeOrder.id)
    expect(preview.traceImpact).toMatchObject({
      suspectAfterRelease: 2,
      newlySuspect: 2,
    })
    expect(tuples).toEqual(
      [
        {
          relationshipType: 'SATISFIES',
          source: part.itemNumber,
          target: requirement.itemNumber,
          reasons: ['target_revised'],
        },
        {
          relationshipType: 'VERIFIED_BY',
          source: testCase.itemNumber,
          target: requirement.itemNumber,
          reasons: ['target_revised'],
        },
      ].sort(byTuple),
    )

    await release(changeOrder)
    expect(await suspectClaimsTouching([requirement.masterId])).toEqual(tuples)
  })

  it('the preview reports nothing for a claim affirmed on the branch, even with both ends in the change order', async () => {
    const { part, requirement } = await releasedSatisfactionClaim('pv-both')
    const { changeOrder, branchId, workingCopyId } =
      await reviseInChangeOrder(part)
    // The requirement revises in the same change order.
    const mainBranch = await BranchService.getMainBranch(designId)
    await testDb.db.insert(branchItems).values({
      branchId: mainBranch!.id,
      itemMasterId: requirement.masterId,
      currentItemId: requirement.id,
      baseItemId: requirement.id,
      changeType: null,
    })
    await CheckoutService.checkout(
      { itemMasterId: requirement.masterId, branchId },
      user.id,
    )
    await CheckoutService.saveChanges(
      {
        branchId,
        itemId: requirement.id,
        changes: { name: 'Requirement revised alongside the part' },
        commitMessage: 'revise',
      },
      user.id,
    )

    const beforeAffirm = await previewTuples(changeOrder.id)
    expect(beforeAffirm.preview.traceImpact.suspectAfterRelease).toBe(1)

    await ItemRelationshipService.affirmRelationship(
      (await RequirementService.getRequirementsSatisfiedBy(workingCopyId))[0]!
        .relationshipId,
      user.id,
    )
    const { preview, tuples } = await previewTuples(changeOrder.id)
    expect(preview.traceImpact).toMatchObject({
      suspectAfterRelease: 0,
      newlySuspect: 0,
    })
    expect(tuples).toEqual([])

    await release(changeOrder)
    expect(
      await suspectClaimsTouching([part.masterId, requirement.masterId]),
    ).toEqual([])
  })

  // ---- The other readers ----

  it('coverage counts a requirement whose claim is suspect, and lists the link, until affirmed', async () => {
    const { part, requirement } = await releasedSatisfactionClaim('coverage')
    const { changeOrder } = await reviseInChangeOrder(requirement)
    await release(changeOrder)
    const revised = await currentRowOf(requirement.masterId)

    // Still counted as satisfied — the link is there — and reported suspect
    // beside it, so the counter cannot read as clean coverage.
    const coverage = await RequirementService.getCoverage(designId)
    expect(coverage).toMatchObject({
      totalRequirements: 1,
      satisfied: 1,
      suspect: 1,
      suspectPercent: 100,
    })
    expect(coverage.suspectLinks).toHaveLength(1)
    expect(coverage.suspectLinks[0]).toMatchObject({
      requirementId: revised,
      requirementNumber: requirement.itemNumber,
      relationshipType: 'SATISFIES',
      counterpartId: part.id,
      counterpartType: 'Part',
      suspectReasons: ['target_revised'],
    })

    // The gap analysis reports the same requirement as a gap of its own.
    const analysis = await GapAnalysisService.analyze({ designId })
    expect(analysis.coverage.requirements).toMatchObject({
      satisfied: 1,
      suspect: 1,
    })
    expect(
      analysis.gaps.filter((gap) => gap.type === 'suspect_requirement'),
    ).toMatchObject([{ itemId: revised, domain: 'requirements' }])

    await ItemRelationshipService.affirmRelationship(
      coverage.suspectLinks[0]!.relationshipId,
      user.id,
    )
    const affirmed = await RequirementService.getCoverage(designId)
    expect(affirmed).toMatchObject({ satisfied: 1, suspect: 0 })
    expect(affirmed.suspectLinks).toEqual([])
    expect(
      (await GapAnalysisService.analyze({ designId })).gaps.filter(
        (gap) => gap.type === 'suspect_requirement',
      ),
    ).toEqual([])
  })

  it('a validation claim is flagged on the part listing when the part revises', async () => {
    const part = await createPart('validated')
    const testCase = await ItemService.create<PersistedItem>(
      'TestCase',
      {
        itemNumber: `TC-${uniquePrefix}-validated`,
        revision: 'A',
        name: 'Static load test',
        designId,
      } as PersistedItem,
      user.id,
    )
    await VerificationService.linkValidation(testCase.id, [part.id], user.id)
    await releaseOnMain(part)

    const { changeOrder } = await reviseInChangeOrder(part)
    await release(changeOrder)
    const released = await currentRowOf(part.masterId)

    // VALIDATES belongs to the test case and names the row the release
    // superseded: inherited by the new revision, and suspect there.
    const validating = await VerificationService.getValidatingTests(released)
    expect(validating).toHaveLength(1)
    expect(validating[0]).toMatchObject({
      id: testCase.id,
      suspect: true,
      suspectReasons: ['target_revised'],
    })
    // And from the test case's side, resolved forward to the released row.
    expect(
      await VerificationService.getPartsValidatedBy(testCase.id),
    ).toMatchObject([
      { id: released, suspect: true, suspectReasons: ['target_revised'] },
    ])
  })

  // ---- Edges and refusals ----

  it('reads an edge that predates affirmations as not suspect while both ends are current', async () => {
    const part = await createPart('legacy')
    const requirement = await createRequirement('legacy')
    const legacy = takeFirst(
      await testDb.db
        .insert(itemRelationships)
        .values({
          sourceId: part.id,
          targetId: requirement.id,
          relationshipType: 'SATISFIES',
          createdBy: user.id,
        })
        .returning(),
    )

    const states = await ItemRelationshipService.suspectStatesFor([legacy.id])
    expect(states.get(legacy.id)).toMatchObject({
      suspect: false,
      reasons: [],
      affirmation: null,
    })
  })

  it('refuses to affirm an edge that is not a trace claim', async () => {
    const parent = await createPart('parent')
    const child = await createPart('child')
    await ItemService.addRelationship(parent.id, child.id, 'BOM', user.id, {
      quantity: '1',
    })
    const [bom] = await testDb.db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, parent.id),
          eq(itemRelationships.relationshipType, 'BOM'),
        ),
      )
      .limit(1)

    await expect(
      ItemRelationshipService.affirmRelationship(bom!.id, user.id),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
