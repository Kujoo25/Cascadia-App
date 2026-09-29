// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq } from 'drizzle-orm'
import { familyNumberingConfig } from '@cascadia/commons/items/numbering/schemes'
import { ItemRelationshipService } from './ItemRelationshipService'
import { ItemService } from './ItemService'
import type { BaseItem } from '@cascadia/commons/items/types/base'
import type { Part } from '@cascadia/commons/items/types/part'
import { db } from '@/db'
import { itemRelationships } from '@/db/schema'
import { NotFoundError, ValidationError } from '@/errors'
import { NumberingService } from '@/items/numbering'
import { BranchService } from '@/services/BranchService'

export const CLONEABLE_ITEM_TYPES = [
  'Part',
  'Document',
  'Requirement',
  'Software',
] as const

export type CloneableItemType = (typeof CLONEABLE_ITEM_TYPES)[number]

export interface CloneItemOptions {
  itemNumber?: string
  name?: string
  branchId?: string
  copyRelationships?: boolean
  copyVariants?: boolean
  variantCode?: string
}

export interface CloneItemResult {
  item: BaseItem
  relationshipsCopied: number
}

const cloneableTypes = new Set<string>(CLONEABLE_ITEM_TYPES)

/**
 * Remove identity, lifecycle and content pointers that must never cross into a
 * new logical item. The registered item schema strips other read-only columns;
 * naming these here documents the fields whose accidental reuse would change
 * the clone's meaning rather than merely be ignored.
 */
function cloneInput(
  source: NonNullable<Awaited<ReturnType<typeof ItemService.findById>>>,
  options: CloneItemOptions,
): BaseItem {
  const data = { ...source } as Record<string, unknown>

  for (const key of [
    'id',
    'masterId',
    'revision',
    'state',
    'isCurrent',
    'createdAt',
    'createdBy',
    'modifiedAt',
    'modifiedBy',
    'lockedBy',
    'lockedAt',
    'commitId',
    'usageOf',
    'usageCount',
    'isDeleted',
    'deletedAt',
    'deletedBy',
  ]) {
    delete data[key]
  }

  data.itemNumber = options.itemNumber
  data.name = options.name ?? source.name ?? undefined

  // Attachments are not part of this operation. These denormalized pointers
  // would otherwise name content owned by the source item without creating a
  // corresponding vault row for the clone.
  if (source.itemType === 'Document') {
    delete data.fileId
    delete data.fileName
    delete data.fileSize
    delete data.mimeType
    delete data.storagePath
  }

  // The source manifest and build artifact are revision content, not basic
  // metadata. A future "Copy files/source" option can clone them deliberately;
  // a plain item clone starts without either and never carries draft editor
  // state from somebody else's item.
  if (source.itemType === 'Software') {
    delete data.manifestId
    delete data.draftManifestId
    delete data.buildArtifactFileId
  }

  if (source.itemType === 'Part') {
    const part = source as Part
    if (options.copyVariants) {
      data.optionModel = part.optionModel ?? null
      data.makes = part.makes ?? null
      data.productFamilyCode = part.productFamilyCode ?? null
      data.variantCode = part.productFamilyCode
        ? options.variantCode
        : (part.variantCode ?? null)
    } else {
      data.optionModel = null
      data.makes = null
      data.productFamilyCode = null
      data.variantCode = null
    }
  }

  return data as unknown as BaseItem
}

/** Clone one design-owned engineering item as a new, independent draft. */
export class ItemCloneService {
  static async clone(
    sourceItemId: string,
    userId: string,
    options: CloneItemOptions,
  ): Promise<CloneItemResult> {
    const source = await ItemService.findById(sourceItemId)
    if (!source) {
      throw new NotFoundError('Item', sourceItemId)
    }
    if (!cloneableTypes.has(source.itemType)) {
      throw new ValidationError(`${source.itemType} items cannot be cloned`)
    }
    if (!source.designId) {
      throw new ValidationError(
        'Only items belonging to a design can be cloned',
      )
    }
    if (options.copyVariants && source.itemType !== 'Part') {
      throw new ValidationError('Variant data can only be copied from Parts')
    }

    if (source.itemType === 'Part' && options.copyVariants) {
      const part = source as Part
      if (part.productFamilyCode) {
        if (!options.variantCode) {
          throw new ValidationError(
            'A new variant code is required when copying a product-family Part',
            [{ field: 'variantCode', message: 'Enter a new variant code' }],
          )
        }
        if (options.variantCode === part.variantCode) {
          throw new ValidationError(
            'The cloned Part must use a different variant code',
            [
              {
                field: 'variantCode',
                message: 'Variant code must differ from the source Part',
              },
            ],
          )
        }
      }
    }

    const relationships = options.copyRelationships
      ? await db
          .select()
          .from(itemRelationships)
          .where(eq(itemRelationships.sourceId, sourceItemId))
      : []

    if (
      source.itemType === 'Part' &&
      !options.copyVariants &&
      relationships.some((relationship) => relationship.option !== null)
    ) {
      throw new ValidationError(
        'Variant-conditioned relationships require variant data to be copied',
        [
          {
            field: 'copyVariants',
            message: 'Select Copy variants to clone this BOM',
          },
        ],
      )
    }

    if (options.branchId) {
      const branch = await BranchService.getById(options.branchId)
      if (!branch || branch.designId !== source.designId) {
        throw new ValidationError(
          'Target branch must belong to the source item design',
        )
      }
    }

    let itemNumber = options.itemNumber
    if (
      !itemNumber &&
      source.itemType === 'Part' &&
      NumberingService.familyVariantsEnabled('Part')
    ) {
      const family = familyNumberingConfig.Part
      itemNumber = await NumberingService.generateFamilyVariant(
        source.itemNumber,
        {
          separator: family?.separator,
          padding: family?.padding,
        },
      )
    }

    const data = cloneInput(source, { ...options, itemNumber })
    const created = options.branchId
      ? (
          await ItemService.createOnBranch(
            source.itemType,
            data,
            options.branchId,
            `Cloned ${source.itemType} ${source.itemNumber}`,
            userId,
          )
        ).item
      : await ItemService.create(source.itemType, data, userId)

    let relationshipsCopied = 0
    if (options.copyRelationships && created.id) {
      relationshipsCopied =
        await ItemRelationshipService.copyRelationshipsToItem({
          sourceItemId,
          targetItemId: created.id,
          userId,
        })
    }

    return { item: created, relationshipsCopied }
  }
}
