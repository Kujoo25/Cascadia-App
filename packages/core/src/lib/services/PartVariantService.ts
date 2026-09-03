// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { TransactionClient } from '@/lib/db'
import type {
  ConfigurePartVariantInput,
  CreateExecutionBomLineInput,
  CreateVariantExecutionInput,
  PartVariantConfiguration,
  ResolvedVariantBomLine,
  UpdateVariantExecutionInput,
  VariantBomTarget,
} from '@/lib/product-variants/types'
import { db } from '@/lib/db'
import {
  branchItems,
  designs,
  items,
  partFamilies,
  partVariantExecutionBomLines,
  partVariantExecutions,
  partVariants,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { BranchService } from '@/lib/services/BranchService'
import { CommitService } from '@/lib/services/CommitService'
import { RevisionService } from '@/lib/services/RevisionService'
import { ItemService } from '@/lib/items/services/ItemService'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { followSupersededRows } from '@/lib/items/version-lineage'
import {
  configurePartVariantSchema,
  createExecutionBomLineSchema,
  createVariantExecutionSchema,
  formatExecutionDesignation,
  updateVariantExecutionSchema,
} from '@/lib/product-variants/types'

type Executor = TransactionClient | typeof db

interface VariantIdentity {
  variantId: string
  partMasterId: string
  variantCode: string
  familyId: string
  familyCode: string
  familyName: string
  familyDescription: string | null
  familyDesignId: string
}

export class PartVariantService {
  private static async requirePart(partItemId: string) {
    const part = await ItemService.findById(partItemId)
    if (!part || part.itemType !== 'Part') {
      throw new NotFoundError('Part', partItemId)
    }
    if (!part.designId) {
      throw new ValidationError('A product Variant must belong to a Design')
    }
    return part
  }

  private static async identityForMaster(
    partMasterId: string,
    executor: Executor = db,
  ): Promise<VariantIdentity | null> {
    const row = (
      await executor
        .select({
          variantId: partVariants.id,
          partMasterId: partVariants.partMasterId,
          variantCode: partVariants.code,
          familyId: partFamilies.id,
          familyCode: partFamilies.code,
          familyName: partFamilies.name,
          familyDescription: partFamilies.description,
          familyDesignId: partFamilies.designId,
        })
        .from(partVariants)
        .innerJoin(partFamilies, eq(partFamilies.id, partVariants.familyId))
        .where(eq(partVariants.partMasterId, partMasterId))
        .limit(1)
    ).at(0)
    return row ?? null
  }

  private static async requireIdentity(partMasterId: string) {
    const identity = await this.identityForMaster(partMasterId)
    if (!identity) {
      throw new ValidationError(
        'This Part is not configured as a product Variant',
      )
    }
    return identity
  }

  private static async requireEditablePart(partItemId: string, userId: string) {
    const part = await this.requirePart(partItemId)
    await ItemService.requireContentEditable(part, userId)
    return part
  }

  private static async branchIdForPart(part: {
    id: string
    designId?: string | null
  }): Promise<string | null> {
    const branchInfo = await ItemService.getItemBranchInfo(part.id)
    if (branchInfo) return branchInfo.branchId
    if (!part.designId) return null
    return (await BranchService.getMainBranch(part.designId))?.id ?? null
  }

  private static async recordChange(
    part: { id: string; designId?: string | null },
    userId: string,
    change: {
      message: string
      fieldName: string
      fieldPath: string
      oldValue: unknown
      newValue: unknown
      category: 'type' | 'relationship'
    },
    tx: TransactionClient,
  ) {
    const branchId = await this.branchIdForPart(part)
    if (!branchId) return
    await CommitService.create(
      {
        branchId,
        message: change.message,
        itemChanges: [
          {
            itemId: part.id,
            changeType: 'modified',
            fieldChanges: [
              {
                fieldName: change.fieldName,
                fieldPath: change.fieldPath,
                oldValue: change.oldValue,
                newValue: change.newValue,
                fieldCategory: change.category,
              },
            ],
          },
        ],
      },
      userId,
      tx,
    )
  }

  static async configureVariant(
    partItemId: string,
    input: ConfigurePartVariantInput,
    userId: string,
  ): Promise<PartVariantConfiguration> {
    const data = configurePartVariantSchema.parse(input)
    const part = await this.requireEditablePart(partItemId, userId)
    const existing = await this.identityForMaster(part.masterId)
    if (existing) {
      if (
        existing.familyCode === data.familyCode &&
        existing.variantCode === data.variantCode
      ) {
        const configuration = await this.getConfiguration(partItemId)
        if (configuration) return configuration
        throw new NotFoundError('Variant configuration', partItemId)
      }
      throw new ValidationError(
        'A Part master cannot be moved to a different product Family or Variant',
      )
    }

    const lineage = await db
      .select({ id: items.id })
      .from(items)
      .where(eq(items.masterId, part.masterId))
      .limit(2)
    if (
      lineage.length !== 1 ||
      !RevisionService.isWorkingRevision(part.revision)
    ) {
      throw new ValidationError(
        'Configure the stable Family and Variant identity before the Part is first released',
      )
    }

    await db.transaction(async (tx) => {
      let family = (
        await tx
          .select()
          .from(partFamilies)
          .where(
            and(
              eq(partFamilies.designId, part.designId!),
              eq(partFamilies.code, data.familyCode),
            ),
          )
          .limit(1)
      ).at(0)

      if (!family) {
        family = takeFirst(
          await tx
            .insert(partFamilies)
            .values({
              designId: part.designId!,
              code: data.familyCode,
              name: data.familyName,
              description: data.familyDescription ?? null,
              createdBy: userId,
              modifiedBy: userId,
            })
            .returning(),
          'part family',
        )
      }

      const occupied = await tx
        .select({ partMasterId: partVariants.partMasterId })
        .from(partVariants)
        .where(
          and(
            eq(partVariants.familyId, family.id),
            eq(partVariants.code, data.variantCode),
          ),
        )
        .limit(1)
      if (occupied.length > 0) {
        throw new ValidationError(
          `${data.familyCode}${data.variantCode} already identifies another Part`,
        )
      }

      await tx.insert(partVariants).values({
        familyId: family.id,
        partMasterId: part.masterId,
        code: data.variantCode,
        createdBy: userId,
      })

      await this.recordChange(
        part,
        userId,
        {
          message: `Configured product Variant ${data.familyCode}${data.variantCode}`,
          fieldName: 'variant_configured',
          fieldPath: 'productVariant',
          oldValue: null,
          newValue: {
            familyCode: data.familyCode,
            variantCode: data.variantCode,
          },
          category: 'type',
        },
        tx,
      )
    })

    const configuration = await this.getConfiguration(partItemId)
    if (!configuration) {
      throw new NotFoundError('Variant configuration', partItemId)
    }
    return configuration
  }

  static async getConfiguration(
    partItemId: string,
  ): Promise<PartVariantConfiguration | null> {
    const part = await this.requirePart(partItemId)
    const identity = await this.identityForMaster(part.masterId)
    if (!identity) return null
    if (identity.familyDesignId !== part.designId) {
      throw new ValidationError(
        'The product Family and Variant Part must belong to the same Design',
      )
    }

    const executions = await db
      .select()
      .from(partVariantExecutions)
      .where(
        and(
          eq(partVariantExecutions.variantId, identity.variantId),
          eq(partVariantExecutions.partItemId, partItemId),
        ),
      )
      .orderBy(partVariantExecutions.code)

    const branchInfo = await ItemService.getItemBranchInfo(partItemId)
    const bomByExecution = await this.executionBomByExecution(
      executions.map((execution) => execution.id),
      branchInfo?.branchId,
    )

    return {
      family: {
        id: identity.familyId,
        code: identity.familyCode,
        name: identity.familyName,
        description: identity.familyDescription,
      },
      variant: {
        id: identity.variantId,
        code: identity.variantCode,
        partMasterId: identity.partMasterId,
        itemId: part.id,
        revision: part.revision,
        baseDesignation: `${identity.familyCode}${identity.variantCode}${revisionLabel(part.revision)}`,
      },
      executions: executions.map((execution) => ({
        id: execution.id,
        executionMasterId: execution.executionMasterId,
        code: execution.code,
        name: execution.name,
        sku: execution.sku,
        isActive: execution.isActive,
        attributes: execution.attributes,
        designation: formatExecutionDesignation({
          familyCode: identity.familyCode,
          variantCode: identity.variantCode,
          revision: part.revision,
          executionCode: execution.code,
        }),
        bomLines: bomByExecution.get(execution.id) ?? [],
      })),
    }
  }

  private static async executionBomByExecution(
    executionIds: Array<string>,
    branchId?: string,
  ): Promise<Map<string, Array<ResolvedVariantBomLine>>> {
    const result = new Map<string, Array<ResolvedVariantBomLine>>()
    for (const id of executionIds) result.set(id, [])
    if (executionIds.length === 0) return result

    const lines = await db
      .select()
      .from(partVariantExecutionBomLines)
      .where(inArray(partVariantExecutionBomLines.executionId, executionIds))
    const targetIds = [...new Set(lines.map((line) => line.targetItemId))]
    const targetRows = await db
      .select({ id: items.id, masterId: items.masterId })
      .from(items)
      .where(inArray(items.id, targetIds))
    const masterByTarget = new Map(
      targetRows.map((target) => [target.id, target.masterId]),
    )
    const branchTargetByMaster = new Map<string, string>()
    if (branchId && targetRows.length > 0) {
      const branchTargets = await db
        .select({
          masterId: branchItems.itemMasterId,
          itemId: branchItems.currentItemId,
        })
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, branchId),
            inArray(
              branchItems.itemMasterId,
              targetRows.map((target) => target.masterId),
            ),
          ),
        )
      for (const target of branchTargets) {
        if (target.itemId)
          branchTargetByMaster.set(target.masterId, target.itemId)
      }
    }
    const redirects = branchId
      ? new Map<string, string>()
      : await followSupersededRows(targetIds)

    for (const line of lines) {
      const targetMasterId = masterByTarget.get(line.targetItemId)
      const target = await ItemService.findById(
        (targetMasterId && branchTargetByMaster.get(targetMasterId)) ??
          redirects.get(line.targetItemId) ??
          line.targetItemId,
      )
      if (!target || target.itemType !== 'Part') continue
      const list = result.get(line.executionId)
      list?.push({
        id: line.id,
        scope: 'execution',
        executionId: line.executionId,
        targetItemId: target.id,
        quantity: line.quantity,
        referenceDesignator: line.referenceDesignator,
        findNumber: line.findNumber,
        targetItem: target as VariantBomTarget,
      })
    }
    return result
  }

  static async createExecution(
    partItemId: string,
    input: CreateVariantExecutionInput,
    userId: string,
  ) {
    const data = createVariantExecutionSchema.parse(input)
    const part = await this.requireEditablePart(partItemId, userId)
    const identity = await this.requireIdentity(part.masterId)

    const current = await db
      .select({ id: partVariantExecutions.id })
      .from(partVariantExecutions)
      .where(
        and(
          eq(partVariantExecutions.partItemId, partItemId),
          eq(partVariantExecutions.code, data.code),
        ),
      )
      .limit(1)
    if (current.length > 0) {
      throw new ValidationError(`Execution ${data.code} already exists`)
    }

    const historical = await db
      .select({ executionMasterId: partVariantExecutions.executionMasterId })
      .from(partVariantExecutions)
      .where(
        and(
          eq(partVariantExecutions.variantId, identity.variantId),
          eq(partVariantExecutions.code, data.code),
        ),
      )
      .limit(1)
    const executionMasterId =
      historical.at(0)?.executionMasterId ?? randomUUID()

    return db.transaction(async (tx) => {
      const execution = takeFirst(
        await tx
          .insert(partVariantExecutions)
          .values({
            executionMasterId,
            variantId: identity.variantId,
            partItemId,
            code: data.code,
            name: data.name ?? null,
            sku: data.sku ?? null,
            isActive: data.isActive,
            attributes: data.attributes,
            createdBy: userId,
            modifiedBy: userId,
          })
          .returning(),
        'variant execution',
      )
      await this.recordChange(
        part,
        userId,
        {
          message: `Added execution ${data.code}`,
          fieldName: 'execution_added',
          fieldPath: `productVariant.executions.${data.code}`,
          oldValue: null,
          newValue: { code: data.code, name: data.name, sku: data.sku },
          category: 'type',
        },
        tx,
      )
      return execution
    })
  }

  static async updateExecution(
    partItemId: string,
    executionId: string,
    input: UpdateVariantExecutionInput,
    userId: string,
  ) {
    const data = updateVariantExecutionSchema.parse(input)
    const part = await this.requireEditablePart(partItemId, userId)
    const before = await this.requireExecution(partItemId, executionId)

    return db.transaction(async (tx) => {
      const updated = takeFirst(
        await tx
          .update(partVariantExecutions)
          .set({ ...data, modifiedAt: new Date(), modifiedBy: userId })
          .where(eq(partVariantExecutions.id, executionId))
          .returning(),
        'variant execution',
      )
      await this.recordChange(
        part,
        userId,
        {
          message: `Updated execution ${before.code}`,
          fieldName: 'execution_updated',
          fieldPath: `productVariant.executions.${before.code}`,
          oldValue: before,
          newValue: updated,
          category: 'type',
        },
        tx,
      )
      return updated
    })
  }

  static async deactivateExecution(
    partItemId: string,
    executionId: string,
    userId: string,
  ) {
    return this.updateExecution(
      partItemId,
      executionId,
      { isActive: false },
      userId,
    )
  }

  private static async requireExecution(
    partItemId: string,
    executionId: string,
  ) {
    const execution = (
      await db
        .select()
        .from(partVariantExecutions)
        .where(
          and(
            eq(partVariantExecutions.id, executionId),
            eq(partVariantExecutions.partItemId, partItemId),
          ),
        )
        .limit(1)
    ).at(0)
    if (!execution) throw new NotFoundError('Variant execution', executionId)
    return execution
  }

  static async addExecutionBomLine(
    partItemId: string,
    executionId: string,
    input: CreateExecutionBomLineInput,
    userId: string,
  ) {
    const data = createExecutionBomLineSchema.parse(input)
    const part = await this.requireEditablePart(partItemId, userId)
    const execution = await this.requireExecution(partItemId, executionId)
    const target = await ItemService.findById(data.targetItemId)
    if (!target || target.itemType !== 'Part') {
      throw new ValidationError('An execution BOM line must target a Part')
    }
    if (target.masterId === part.masterId) {
      throw new ValidationError('A Variant cannot contain itself')
    }

    const targetDesign = target.designId
      ? (
          await db
            .select({ designType: designs.designType })
            .from(designs)
            .where(eq(designs.id, target.designId))
            .limit(1)
        ).at(0)
      : null
    if (
      target.designId !== part.designId &&
      targetDesign?.designType !== 'Library'
    ) {
      throw new ValidationError(
        'Execution BOM targets must belong to the Variant Design or a Library',
      )
    }

    const common = await ItemRelationshipService.getRelationshipsWithDetails(
      partItemId,
      'BOM',
    )
    if (common.some((line) => line.targetItem?.masterId === target.masterId)) {
      throw new ValidationError(
        'This Part is already present in the common Variant BOM',
      )
    }

    const existingOverlay = await this.executionBomByExecution([executionId])
    if (
      existingOverlay
        .get(executionId)
        ?.some((line) => line.targetItem.masterId === target.masterId)
    ) {
      throw new ValidationError('This Part is already present in the MK BOM')
    }

    return db.transaction(async (tx) => {
      const line = takeFirst(
        await tx
          .insert(partVariantExecutionBomLines)
          .values({
            executionId,
            targetItemId: target.id,
            quantity: data.quantity,
            referenceDesignator: data.referenceDesignator ?? null,
            findNumber: data.findNumber ?? null,
            createdBy: userId,
            modifiedBy: userId,
          })
          .returning(),
        'execution BOM line',
      )
      await this.recordChange(
        part,
        userId,
        {
          message: `Added ${target.itemNumber} to ${execution.code}`,
          fieldName: 'execution_bom_added',
          fieldPath: `productVariant.executions.${execution.code}.bom`,
          oldValue: null,
          newValue: {
            targetItemId: target.id,
            targetItemNumber: target.itemNumber,
            quantity: data.quantity,
          },
          category: 'relationship',
        },
        tx,
      )
      return line
    })
  }

  /** Keep a common BOM line from duplicating an execution-specific addition. */
  static async assertCommonBomTargetNotOverlaid(
    partItemId: string,
    targetItemId: string,
  ): Promise<void> {
    const target = await ItemService.findById(targetItemId)
    if (!target) return
    const duplicate = await db
      .select({ id: partVariantExecutionBomLines.id })
      .from(partVariantExecutionBomLines)
      .innerJoin(
        partVariantExecutions,
        eq(partVariantExecutions.id, partVariantExecutionBomLines.executionId),
      )
      .innerJoin(items, eq(items.id, partVariantExecutionBomLines.targetItemId))
      .where(
        and(
          eq(partVariantExecutions.partItemId, partItemId),
          eq(items.masterId, target.masterId),
        ),
      )
      .limit(1)
    if (duplicate.length > 0) {
      throw new ValidationError(
        'This Part is already present in an MK-specific BOM. Remove that line before adding it to the common Variant BOM.',
      )
    }
  }

  static async removeExecutionBomLine(
    partItemId: string,
    executionId: string,
    lineId: string,
    userId: string,
  ) {
    const part = await this.requireEditablePart(partItemId, userId)
    const execution = await this.requireExecution(partItemId, executionId)
    await db.transaction(async (tx) => {
      const line = (
        await tx
          .delete(partVariantExecutionBomLines)
          .where(
            and(
              eq(partVariantExecutionBomLines.id, lineId),
              eq(partVariantExecutionBomLines.executionId, executionId),
            ),
          )
          .returning()
      ).at(0)
      if (!line) throw new NotFoundError('Execution BOM line', lineId)
      await this.recordChange(
        part,
        userId,
        {
          message: `Removed a BOM line from ${execution.code}`,
          fieldName: 'execution_bom_removed',
          fieldPath: `productVariant.executions.${execution.code}.bom`,
          oldValue: line,
          newValue: null,
          category: 'relationship',
        },
        tx,
      )
    })
  }

  static async getResolvedBom(
    partItemId: string,
    executionId: string,
  ): Promise<Array<ResolvedVariantBomLine>> {
    const configuration = await this.getConfiguration(partItemId)
    if (!configuration) {
      throw new ValidationError('This Part is not a product Variant')
    }
    const execution = configuration.executions.find(
      (candidate) => candidate.id === executionId,
    )
    if (!execution) throw new NotFoundError('Variant execution', executionId)
    if (!execution.isActive) {
      throw new ValidationError('Cannot resolve an inactive execution')
    }

    const branchInfo = await ItemService.getItemBranchInfo(partItemId)
    const common = branchInfo
      ? await ItemRelationshipService.getRelationshipsWithDetailsForBranch(
          partItemId,
          branchInfo.branchId,
          'BOM',
        )
      : await ItemRelationshipService.getRelationshipsWithDetails(
          partItemId,
          'BOM',
        )
    return [
      ...common.map((line) => ({
        id: line.id,
        scope: 'variant' as const,
        targetItemId: line.targetItem!.id,
        quantity: line.quantity,
        referenceDesignator: line.referenceDesignator,
        findNumber: line.findNumber,
        targetItem: line.targetItem as VariantBomTarget,
      })),
      ...execution.bomLines,
    ]
  }

  /** Carry every MK snapshot and its additions onto a new Part version. */
  static async copyVersionData(
    sourcePartItemId: string,
    targetPartItemId: string,
    tx?: TransactionClient,
  ): Promise<void> {
    const executor = tx ?? db
    const sourceExecutions = await executor
      .select()
      .from(partVariantExecutions)
      .where(eq(partVariantExecutions.partItemId, sourcePartItemId))
    if (sourceExecutions.length === 0) return

    for (const source of sourceExecutions) {
      const { id: _id, partItemId: _partItemId, ...copy } = source
      const inserted = await executor
        .insert(partVariantExecutions)
        .values({ ...copy, partItemId: targetPartItemId })
        .onConflictDoNothing()
        .returning()
      const target =
        inserted.at(0) ??
        takeFirst(
          await executor
            .select()
            .from(partVariantExecutions)
            .where(
              and(
                eq(partVariantExecutions.partItemId, targetPartItemId),
                eq(
                  partVariantExecutions.executionMasterId,
                  source.executionMasterId,
                ),
              ),
            )
            .limit(1),
          'copied variant execution',
        )
      const sourceLines = await executor
        .select()
        .from(partVariantExecutionBomLines)
        .where(eq(partVariantExecutionBomLines.executionId, source.id))
      if (sourceLines.length === 0) continue

      await executor
        .insert(partVariantExecutionBomLines)
        .values(
          sourceLines.map(
            ({ id: _lineId, executionId: _executionId, ...line }) => ({
              ...line,
              executionId: target.id,
            }),
          ),
        )
        .onConflictDoNothing()
    }
  }
}

function revisionLabel(revision: string): string {
  return !revision || revision === 'DRAFT' || revision.startsWith('-')
    ? 'DRAFT'
    : revision
}
