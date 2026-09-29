// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { variantCodeSchema } from '@cascadia/commons/types/variants'
import { tagged } from '../../adapter'
import { apiHandler, created } from '@/api/handler'
import { requireBranchAccess, requireItemAccess } from '@/auth/access'
import { requirePermission } from '@/auth/server'
import { ValidationError } from '@/errors'
import { getResourceType } from '@/items/item-type-resources'
import { ItemCloneService } from '@/items/services/ItemCloneService'

const adapt = tagged('Items')
const app = new Hono()

const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const cloneItemSchema = z.object({
  itemNumber: z.preprocess(
    blankToUndefined,
    z.string().trim().min(1).max(100).optional(),
  ),
  name: z.string().max(500).optional(),
  branchId: z.string().uuid().optional(),
  copyRelationships: z.boolean().optional().default(false),
  copyVariants: z.boolean().optional().default(false),
  variantCode: z.preprocess(blankToUndefined, variantCodeSchema.optional()),
})

const clonedItemSchema = z
  .object({
    id: z.string().uuid(),
    masterId: z.string().uuid(),
    itemNumber: z.string(),
    itemType: z.string(),
    revision: z.string(),
    state: z.string(),
  })
  .passthrough()

// POST /api/items/:id/clone
app.post(
  '/:id/clone',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof cloneItemSchema>>(
      {
        body: cloneItemSchema,
        openapi: {
          summary: 'Clone an engineering item as a new draft',
          description:
            'Creates a new independent Part, Document, Requirement, or ' +
            'Software item in the source design. Basic fields are copied; ' +
            'outgoing relationships and Part variant data are opt-in. ' +
            'Identity, lifecycle history, files, source manifests, build ' +
            'artifacts, checkouts, and ECO membership are never copied.',
          request: { body: { schema: cloneItemSchema } },
          responses: {
            201: {
              schema: z.object({
                item: clonedItemSchema,
                relationshipsCopied: z.number().int().nonnegative(),
              }),
              description: 'The newly created draft item.',
            },
          },
        },
      },
      async ({ request, params, body, user }) => {
        const source = await requireItemAccess(user.id, params.id)
        const resource = getResourceType(source.itemType)
        await requirePermission(request, resource, 'read')
        await requirePermission(request, resource, 'create')

        if (body.branchId) {
          const { designId } = await requireBranchAccess(user.id, body.branchId)
          if (!source.designId || designId !== source.designId) {
            throw new ValidationError(
              'Target branch must belong to the source item design',
            )
          }
        }

        return created(await ItemCloneService.clone(params.id, user.id, body))
      },
    ),
  ),
)

export default app
