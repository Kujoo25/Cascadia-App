// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { randomUUID } from 'node:crypto'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { PartVariantService } from './PartVariantService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  designs,
  itemRelationships,
  items,
  partFamilies,
  partVariantExecutionBomLines,
  partVariantExecutions,
  partVariants,
  parts,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'
import { ImpactAssessmentService } from '@/lib/items/services/ImpactAssessmentService'

describe('PartVariantService', () => {
  const testDb = new TestDatabase()
  let user: TestUser

  beforeAll(() => testDb.setup())
  afterAll(async () => testDb.teardown())

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
  })

  afterEach(async () => testDb.rollback())

  async function seedVariant() {
    const suffix = randomUUID().slice(0, 8).toUpperCase()
    const design = takeFirst(
      await testDb.db
        .insert(designs)
        .values({
          code: `VAR-${suffix}`,
          name: 'Variant design',
          createdBy: user.id,
        })
        .returning(),
    )

    const createPart = async (itemNumber: string, name: string) => {
      const item = takeFirst(
        await testDb.db
          .insert(items)
          .values({
            masterId: randomUUID(),
            itemNumber: `${itemNumber}-${suffix}`,
            revision: 'R2',
            itemType: 'Part',
            name,
            state: 'Released',
            isCurrent: true,
            designId: design.id,
            createdBy: user.id,
            modifiedBy: user.id,
          })
          .returning(),
      )
      await testDb.db.insert(parts).values({ itemId: item.id })
      return item
    }

    const variantPart = await createPart('P3001V1', 'Hotel controller')
    const commonPart = await createPart('B3001', 'Lower PCB')
    const mkPart = await createPart('H3001', 'Black housing')
    const family = takeFirst(
      await testDb.db
        .insert(partFamilies)
        .values({
          designId: design.id,
          code: 'P3001',
          name: 'Hotel controller family',
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning(),
    )
    const variant = takeFirst(
      await testDb.db
        .insert(partVariants)
        .values({
          familyId: family.id,
          partMasterId: variantPart.masterId,
          code: 'V1',
          createdBy: user.id,
        })
        .returning(),
    )
    const execution = takeFirst(
      await testDb.db
        .insert(partVariantExecutions)
        .values({
          variantId: variant.id,
          partItemId: variantPart.id,
          code: 'MK1',
          name: 'Black',
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning(),
    )
    await testDb.db.insert(itemRelationships).values({
      sourceId: variantPart.id,
      targetId: commonPart.id,
      relationshipType: 'BOM',
      quantity: '1',
      createdBy: user.id,
    })
    await testDb.db.insert(partVariantExecutionBomLines).values({
      executionId: execution.id,
      targetItemId: mkPart.id,
      quantity: '2',
      createdBy: user.id,
      modifiedBy: user.id,
    })

    return { commonPart, execution, mkPart, variantPart }
  }

  it('resolves the common Variant BOM together with the selected MK additions', async () => {
    const { execution, variantPart } = await seedVariant()

    const lines = await PartVariantService.getResolvedBom(
      variantPart.id,
      execution.id,
    )

    expect(lines).toHaveLength(2)
    expect(lines.map((line) => line.scope).sort()).toEqual([
      'execution',
      'variant',
    ])
    expect(lines.find((line) => line.scope === 'execution')?.quantity).toBe(
      '2.000',
    )
  })

  it('includes an active MK-only component in Variant where-used impact', async () => {
    const { mkPart, variantPart } = await seedVariant()

    const whereUsed = await ImpactAssessmentService.findWhereUsed(mkPart.id)

    expect(whereUsed.some((node) => node.itemId === variantPart.id)).toBe(true)
  })

  it('prevents the same component from being common and MK-specific', async () => {
    const { mkPart, variantPart } = await seedVariant()

    await expect(
      PartVariantService.assertCommonBomTargetNotOverlaid(
        variantPart.id,
        mkPart.id,
      ),
    ).rejects.toThrow('already present in an MK-specific BOM')
  })
})
