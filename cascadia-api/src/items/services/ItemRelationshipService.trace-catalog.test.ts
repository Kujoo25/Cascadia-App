// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The relationship catalog's rules on the trace graph, and the two reads that
 * had to change beside it.
 *
 * Data-integrity gate: a trace edge stored in the wrong direction is a claim
 * no reader finds; a branch's working copy leaking into main's reads
 * double-counts a part on the released baseline; a validation link writable
 * onto a released part on protected main is a change outside any change
 * order. Each of these is pinned as the invariant, not the call shape.
 *
 * Run: npx vitest run cascadia-api/src/items/services/ItemRelationshipService.trace-catalog.test.ts
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
import { DERIVES_FROM_RELATIONSHIP } from '../traceability-relationships'
import { BranchProtectionError, ValidationError } from '../../errors'
import { BranchService } from '../../services/BranchService'
import { CheckoutService } from '../../services/CheckoutService'
import { DesignService } from '../../services/DesignService'
import { RequirementService } from '../../services/RequirementService'
import { VerificationService } from '../../services/VerificationService'
import { ItemRelationshipService } from './ItemRelationshipService'
import { ChangeOrderService } from './ChangeOrderService'
import { ItemService } from './ItemService'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { PersistedItem } from '@cascadia/commons/items/types/base'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import {
  branchItems,
  itemRelationships,
  items,
  programMembers,
  programs,
} from '@/db/schema'
import { itemVersions } from '@/db/schema/versioning'
import { takeFirst } from '@/db/take-first'
import '@/items/registerItemTypes.server'

describe('ItemRelationshipService — the trace catalog', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string
  let initialCommitId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    uniquePrefix = `C${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Catalog Program',
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
        name: 'Catalog Design',
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

  async function create(
    itemType: 'Part' | 'Requirement' | 'TestCase' | 'Task',
    suffix: string,
  ): Promise<PersistedItem> {
    return ItemService.create<PersistedItem>(
      itemType,
      {
        itemNumber: `${itemType.slice(0, 3).toUpperCase()}-${uniquePrefix}-${suffix}`,
        revision: 'A',
        name: `${itemType} ${suffix}`,
        designId,
      } as PersistedItem,
      user.id,
    )
  }

  /** Release a row on main: the released baseline, named by the initial commit. */
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

  async function edgesOfType(relationshipType: string, sourceId: string) {
    return testDb.db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, sourceId),
          eq(itemRelationships.relationshipType, relationshipType),
        ),
      )
  }

  describe('a cataloged type runs one way', () => {
    it('refuses a SATISFIES claim stored requirement → part', async () => {
      const requirement = await create('Requirement', 'r')
      const part = await create('Part', 'p')

      await expect(
        ItemService.addRelationship(
          requirement.id,
          part.id,
          'SATISFIES',
          user.id,
        ),
      ).rejects.toBeInstanceOf(ValidationError)
      expect(await edgesOfType('SATISFIES', requirement.id)).toHaveLength(0)
    })

    it('refuses a satisfying item of a type the catalog does not admit', async () => {
      const requirement = await create('Requirement', 'r')
      const task = await create('Task', 't')

      await expect(
        RequirementService.linkSatisfaction(requirement.id, [task.id], user.id),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('leaves a user-defined type unpoliced', async () => {
      const requirement = await create('Requirement', 'r')
      const part = await create('Part', 'p')

      await ItemService.addRelationship(
        requirement.id,
        part.id,
        'Reference',
        user.id,
      )
      expect(await edgesOfType('Reference', requirement.id)).toHaveLength(1)
    })
  })

  describe('the edit guard reaches VALIDATES', () => {
    it('refuses a validation link onto a released part on protected main', async () => {
      // Authored before the release: main closes to new items once the design
      // has released one, test cases included.
      const testCase = await create('TestCase', 'tc')
      const part = await create('Part', 'p')
      await releaseOnMain(part)

      // The source is a Free-lifecycle test case, exempt from branch
      // protection; the guard has to fall on the part end to refuse this.
      await expect(
        VerificationService.linkValidation(testCase.id, [part.id], user.id),
      ).rejects.toBeInstanceOf(BranchProtectionError)
      expect(await edgesOfType('VALIDATES', testCase.id)).toHaveLength(0)
    })
  })

  describe('a branch keeps its working copies to itself', () => {
    it("main's satisfying items never include another branch's working copy", async () => {
      const part = await create('Part', 'p')
      const requirement = await create('Requirement', 'r')
      await RequirementService.linkSatisfaction(
        requirement.id,
        [part.id],
        user.id,
      )
      await releaseOnMain(part)
      await releaseOnMain(requirement)

      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        `ws-${uniquePrefix}`,
      )
      const { workingCopy } =
        await ChangeOrderService.createRevisionWorkingCopy(
          (await ItemService.findById(part.id)) as unknown as Parameters<
            typeof ChangeOrderService.createRevisionWorkingCopy
          >[0],
          branch.id,
          user.id,
        )
      // The copy carried the claim, so two rows now point at the requirement.
      expect(await edgesOfType('SATISFIES', workingCopy.id)).toHaveLength(1)

      const onMain = await RequirementService.getSatisfyingItems(requirement.id)
      expect(onMain.map((item) => item.id)).toEqual([part.id])
    })

    it('a working copy on the same branch is listed there', async () => {
      const part = await create('Part', 'p')
      const requirement = await create('Requirement', 'r')
      await RequirementService.linkSatisfaction(
        requirement.id,
        [part.id],
        user.id,
      )
      await releaseOnMain(part)
      await releaseOnMain(requirement)

      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        `ws-${uniquePrefix}`,
      )
      const asRow = async (id: string) =>
        (await ItemService.findById(id)) as unknown as Parameters<
          typeof ChangeOrderService.createRevisionWorkingCopy
        >[0]
      const { workingCopy: partCopy } =
        await ChangeOrderService.createRevisionWorkingCopy(
          await asRow(part.id),
          branch.id,
          user.id,
        )
      const { workingCopy: requirementCopy } =
        await ChangeOrderService.createRevisionWorkingCopy(
          await asRow(requirement.id),
          branch.id,
          user.id,
        )

      // Once, as the branch's own copy — not beside the released row it was
      // copied from, which is what the branch read listed until 2026-10-09.
      const onBranch = await RequirementService.getSatisfyingItems(
        requirementCopy.id,
      )
      expect(onBranch.map((item) => item.id)).toEqual([partCopy.id])

      // And the branch's row is tracked where the filter expects it.
      const [tracked] = await testDb.db
        .select({ branchId: branchItems.branchId })
        .from(branchItems)
        .where(eq(branchItems.currentItemId, partCopy.id))
      expect(tracked?.branchId).toBe(branch.id)
    })

    it('a branch whose copy dropped the claim lists nothing for that part', async () => {
      const part = await create('Part', 'p')
      const requirement = await create('Requirement', 'r')
      await RequirementService.linkSatisfaction(
        requirement.id,
        [part.id],
        user.id,
      )
      await releaseOnMain(part)
      await releaseOnMain(requirement)

      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        `ws-${uniquePrefix}`,
      )
      const asRow = async (id: string) =>
        (await ItemService.findById(id)) as unknown as Parameters<
          typeof ChangeOrderService.createRevisionWorkingCopy
        >[0]
      const { workingCopy: partCopy } =
        await ChangeOrderService.createRevisionWorkingCopy(
          await asRow(part.id),
          branch.id,
          user.id,
        )
      const { workingCopy: requirementCopy } =
        await ChangeOrderService.createRevisionWorkingCopy(
          await asRow(requirement.id),
          branch.id,
          user.id,
        )
      // The branch withdraws the claim on its copy: what the merge would
      // release is a part that no longer satisfies the requirement.
      await testDb.db
        .delete(itemRelationships)
        .where(eq(itemRelationships.sourceId, partCopy.id))

      expect(
        await RequirementService.getSatisfyingItems(requirementCopy.id),
      ).toEqual([])
      // Main is untouched by the branch's withdrawal.
      expect(
        (await RequirementService.getSatisfyingItems(requirement.id)).map(
          (item) => item.id,
        ),
      ).toEqual([part.id])
    })

    it('a checkout that has not saved still answers with the released row', async () => {
      const part = await create('Part', 'p')
      const requirement = await create('Requirement', 'r')
      await RequirementService.linkSatisfaction(
        requirement.id,
        [part.id],
        user.id,
      )
      await releaseOnMain(part)
      await releaseOnMain(requirement)

      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        `ws-${uniquePrefix}`,
      )
      const { workingCopy: requirementCopy } =
        await ChangeOrderService.createRevisionWorkingCopy(
          (await ItemService.findById(requirement.id)) as unknown as Parameters<
            typeof ChangeOrderService.createRevisionWorkingCopy
          >[0],
          branch.id,
          user.id,
        )
      // Checked out but never saved: the branch tracks the part, and the row
      // it shows for it is still the released one.
      await CheckoutService.checkout(
        { itemMasterId: part.masterId, branchId: branch.id },
        user.id,
      )

      expect(
        (await RequirementService.getSatisfyingItems(requirementCopy.id)).map(
          (item) => item.id,
        ),
      ).toEqual([part.id])
    })
  })

  describe('derive writes the hierarchy as an edge too', () => {
    it('records exactly one DERIVES_FROM edge, child → parent, on main', async () => {
      const parent = await create('Requirement', 'parent')

      const child = await RequirementService.deriveRequirement(
        parent.id,
        { name: 'Child' },
        user.id,
      )

      const edges = await edgesOfType(DERIVES_FROM_RELATIONSHIP, child.id!)
      expect(edges).toHaveLength(1)
      expect(edges[0]).toMatchObject({ targetId: parent.id })
      expect(child.parentRequirementId).toBe(parent.id)
    })

    it('pins the branch rows when derived inside a branch', async () => {
      const parent = await create('Requirement', 'parent')
      const branch = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        `ws-${uniquePrefix}`,
      )

      const child = await RequirementService.deriveRequirement(
        parent.id,
        { name: 'Branch child' },
        user.id,
        { branchId: branch.id },
      )

      const edges = await edgesOfType(DERIVES_FROM_RELATIONSHIP, child.id!)
      expect(edges).toHaveLength(1)
      // The parent has no working copy on the branch, so the edge names the
      // row the caller named; a checked-out parent would resolve to its copy.
      expect(edges[0]).toMatchObject({ targetId: parent.id })
      await expect(
        ItemRelationshipService.suspectStatesFor([edges[0]!.id]),
      ).resolves.toBeInstanceOf(Map)
    })
  })
})
