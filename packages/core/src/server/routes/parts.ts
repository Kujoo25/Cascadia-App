// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { tagged } from '../adapter'
import type { Part } from '@/lib/items/types/part'
import type { PartUpdate } from '@/lib/api/schemas'
import type {
  ConfigurePartVariantInput,
  CreateExecutionBomLineInput,
  CreateVariantExecutionInput,
  UpdateVariantExecutionInput,
} from '@/lib/product-variants/types'
import { ItemService } from '@/lib/items/services/ItemService'
import { VerificationService } from '@/lib/services/VerificationService'
import { ParametricResolutionService } from '@/lib/services/ParametricResolutionService'
import { PartVariantService } from '@/lib/services/PartVariantService'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { apiHandler, created } from '@/lib/api/handler'
import { requireItemAccess, requireItemsAccess } from '@/lib/auth/access'
import { mountRoutes } from '@/lib/api/route-registry'
import { partUpdateSchema } from '@/lib/api/schemas'
import {
  configurePartVariantSchema,
  createExecutionBomLineSchema,
  createVariantExecutionSchema,
  updateVariantExecutionSchema,
} from '@/lib/product-variants/types'
import { db } from '@/lib/db'
import {
  items,
  workInstructionPartAttachments,
  workInstructions,
} from '@/lib/db/schema'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Parts')

const app = new Hono()

const partIdParamSchema = z.object({ id: z.string().uuid() })
const executionParamSchema = partIdParamSchema.extend({
  executionId: z.string().uuid(),
})
const executionBomLineParamSchema = executionParamSchema.extend({
  lineId: z.string().uuid(),
})
const partResponseSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    partType: z.string().nullable(),
  })
  .passthrough()

// GET /api/parts/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['parts', 'read'],
        openapi: {
          summary: 'Get a part by ID',
          request: { params: partIdParamSchema },
          responses: {
            200: { schema: z.object({ part: partResponseSchema }) },
          },
        },
      },
      async ({ params, user }) => {
        const { id } = params
        await requireItemAccess(user.id, id)
        const part = await ItemService.findById(id)
        if (!part) throw new NotFoundError('Part', id)
        return { part }
      },
    ),
  ),
)

// GET /api/parts/:id/variant-configuration
app.get(
  '/:id/variant-configuration',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['parts', 'read'],
        openapi: {
          summary: 'Get the product Variant and MK configuration',
          request: { params: partIdParamSchema },
          responses: {
            200: {
              schema: z.object({ configuration: z.unknown().nullable() }),
            },
          },
        },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        return {
          configuration: await PartVariantService.getConfiguration(params.id),
        }
      },
    ),
  ),
)

// POST /api/parts/:id/variant-configuration
app.post(
  '/:id/variant-configuration',
  adapt(
    apiHandler<{ id: string }, ConfigurePartVariantInput>(
      {
        permission: ['parts', 'update'],
        body: configurePartVariantSchema,
        openapi: {
          summary: 'Configure a Part as a product Variant',
          request: { params: partIdParamSchema },
          responses: {
            201: { schema: z.object({ configuration: z.unknown() }) },
          },
        },
      },
      async ({ params, body, user }) => {
        await requireItemAccess(user.id, params.id)
        return created({
          configuration: await PartVariantService.configureVariant(
            params.id,
            body,
            user.id,
          ),
        })
      },
    ),
  ),
)

// POST /api/parts/:id/variant-executions
app.post(
  '/:id/variant-executions',
  adapt(
    apiHandler<{ id: string }, CreateVariantExecutionInput>(
      {
        permission: ['parts', 'update'],
        body: createVariantExecutionSchema,
        openapi: { request: { params: partIdParamSchema } },
      },
      async ({ params, body, user }) => {
        await requireItemAccess(user.id, params.id)
        return created({
          execution: await PartVariantService.createExecution(
            params.id,
            body,
            user.id,
          ),
        })
      },
    ),
  ),
)

// PUT /api/parts/:id/variant-executions/:executionId
app.put(
  '/:id/variant-executions/:executionId',
  adapt(
    apiHandler<
      { id: string; executionId: string },
      UpdateVariantExecutionInput
    >(
      {
        permission: ['parts', 'update'],
        body: updateVariantExecutionSchema,
        openapi: { request: { params: executionParamSchema } },
      },
      async ({ params, body, user }) => {
        await requireItemAccess(user.id, params.id)
        return {
          execution: await PartVariantService.updateExecution(
            params.id,
            params.executionId,
            body,
            user.id,
          ),
        }
      },
    ),
  ),
)

// DELETE /api/parts/:id/variant-executions/:executionId (soft delete)
app.delete(
  '/:id/variant-executions/:executionId',
  adapt(
    apiHandler<{ id: string; executionId: string }>(
      {
        permission: ['parts', 'update'],
        openapi: { request: { params: executionParamSchema } },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        await PartVariantService.deactivateExecution(
          params.id,
          params.executionId,
          user.id,
        )
        return { success: true }
      },
    ),
  ),
)

// POST /api/parts/:id/variant-executions/:executionId/bom
app.post(
  '/:id/variant-executions/:executionId/bom',
  adapt(
    apiHandler<
      { id: string; executionId: string },
      CreateExecutionBomLineInput
    >(
      {
        permission: ['parts', 'update'],
        body: createExecutionBomLineSchema,
        openapi: { request: { params: executionParamSchema } },
      },
      async ({ params, body, user }) => {
        await requireItemsAccess(user.id, [params.id, body.targetItemId])
        return created({
          line: await PartVariantService.addExecutionBomLine(
            params.id,
            params.executionId,
            body,
            user.id,
          ),
        })
      },
    ),
  ),
)

// DELETE /api/parts/:id/variant-executions/:executionId/bom/:lineId
app.delete(
  '/:id/variant-executions/:executionId/bom/:lineId',
  adapt(
    apiHandler<{ id: string; executionId: string; lineId: string }>(
      {
        permission: ['parts', 'update'],
        openapi: { request: { params: executionBomLineParamSchema } },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        await PartVariantService.removeExecutionBomLine(
          params.id,
          params.executionId,
          params.lineId,
          user.id,
        )
        return { success: true }
      },
    ),
  ),
)

// GET /api/parts/:id/variant-executions/:executionId/resolved-bom
app.get(
  '/:id/variant-executions/:executionId/resolved-bom',
  adapt(
    apiHandler<{ id: string; executionId: string }>(
      {
        permission: ['parts', 'read'],
        openapi: { request: { params: executionParamSchema } },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        return {
          lines: await PartVariantService.getResolvedBom(
            params.id,
            params.executionId,
          ),
        }
      },
    ),
  ),
)

// PUT /api/parts/:id
app.put(
  '/:id',
  adapt(
    // Both type arguments are spelled out: naming `TParams` turns off
    // inference for the rest, so `TBody` would fall back to `unknown` and
    // `body` would arrive untyped. Any route that declares both params and a
    // body schema names both.
    apiHandler<{ id: string }, PartUpdate>(
      {
        permission: ['parts', 'update'],
        body: partUpdateSchema,
        openapi: {
          summary: 'Update a part',
          request: { params: partIdParamSchema },
          responses: {
            200: { schema: z.object({ part: partResponseSchema }) },
          },
        },
      },
      async ({ params, body, user }) => {
        const { id } = params
        await requireItemAccess(user.id, id)
        // The schema permits `null` where the column is nullable, which the
        // Part interface spells as an absent optional. `ItemService.update`
        // and the part type handler both read null as "clear the column".
        const part = await ItemService.update<Part>(
          id,
          body as Partial<Part>,
          user.id,
        )
        return { part }
      },
    ),
  ),
)

// DELETE /api/parts/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['parts', 'delete'],
        openapi: {
          summary: 'Delete a part',
          request: { params: partIdParamSchema },
          responses: {
            200: { schema: z.object({ success: z.boolean() }) },
          },
        },
      },
      async ({ params, user }) => {
        const { id } = params
        await requireItemAccess(user.id, id)
        await ItemService.delete(id, user.id)
        return { success: true }
      },
    ),
  ),
)

// Generative CAD actions on a part are contributed by an optional package and
// mount here. Nothing is registered on a core-only build. Placed ahead of the
// remaining /:id/* routes for readability; the paths do not overlap.
mountRoutes(app, 'parts')

// GET /api/parts/:id/resolvable-attributes
app.get(
  '/:id/resolvable-attributes',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['parts', 'read'] },
      async ({ params, user }) => {
        const { id } = params
        await requireItemAccess(user.id, id)
        const attributes =
          await ParametricResolutionService.getResolvableAttributes(id)

        return { attributes }
      },
    ),
  ),
)

// POST /api/parts/:id/validate
app.post(
  '/:id/validate',
  adapt(
    apiHandler<{ id: string }, { testCaseIds: Array<string> }>(
      {
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: z.object({
          testCaseIds: z.array(z.string().uuid()).max(1000),
        }),
      },
      async ({ params, body: { testCaseIds }, user }) => {
        const { id } = params

        // The test cases, which `access:` cannot reach — it runs before the
        // body is read, and only the part is named in the path.
        await requireItemsAccess(user.id, testCaseIds)

        // Link each test case to this part (testCase -> part)
        for (const testCaseId of testCaseIds) {
          await VerificationService.linkValidation(testCaseId, [id], user.id)
        }

        return created({ success: true })
      },
    ),
  ),
)

// DELETE /api/parts/:id/validate
app.delete(
  '/:id/validate',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const { id } = params
      await requireItemAccess(user.id, id)
      const url = new URL(request.url)
      const testCaseId = url.searchParams.get('testCaseId')

      if (!testCaseId) {
        throw new ValidationError('testCaseId query parameter is required')
      }

      await requireItemsAccess(user.id, [testCaseId])
      await VerificationService.unlinkValidation(testCaseId, id, user.id)

      return { success: true }
    }),
  ),
)

// GET /api/parts/:id/validating-tests
app.get(
  '/:id/validating-tests',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      const { id } = params
      await requireItemAccess(user.id, id)
      const tests = await VerificationService.getValidatingTests(id)

      return { tests }
    }),
  ),
)

// GET /api/parts/:id/work-instructions
app.get(
  '/:id/work-instructions',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['parts', 'read'] },
      async ({ params, user }) => {
        const { id } = params
        // Verify part exists
        const [part] = await db
          .select()
          .from(items)
          .where(eq(items.id, id))
          .limit(1)

        if (!part || part.itemType !== 'Part') {
          throw new NotFoundError('Part', id)
        }

        // The row is already in hand, so this costs no second read.
        await requireItemAccess(user.id, part)

        // Get work instructions attached to this part
        const attachedWIs = await db
          .select({
            attachmentId: workInstructionPartAttachments.id,
            inheritToMBOM: workInstructionPartAttachments.inheritToMBOM,
            createdAt: workInstructionPartAttachments.createdAt,
            workInstruction: {
              id: items.id,
              itemNumber: items.itemNumber,
              name: items.name,
              revision: items.revision,
              state: items.state,
            },
            workInstructionDetails: {
              description: workInstructions.description,
              estimatedTime: workInstructions.estimatedTime,
              difficulty: workInstructions.difficulty,
            },
          })
          .from(workInstructionPartAttachments)
          .innerJoin(
            items,
            eq(workInstructionPartAttachments.workInstructionId, items.id),
          )
          .innerJoin(
            workInstructions,
            eq(
              workInstructionPartAttachments.workInstructionId,
              workInstructions.itemId,
            ),
          )
          .where(eq(workInstructionPartAttachments.partId, id))

        // Flatten the response
        const workInstructionsList = attachedWIs.map((row) => ({
          attachmentId: row.attachmentId,
          inheritToMBOM: row.inheritToMBOM,
          attachedAt: row.createdAt,
          id: row.workInstruction.id,
          itemNumber: row.workInstruction.itemNumber,
          name: row.workInstruction.name,
          revision: row.workInstruction.revision,
          state: row.workInstruction.state,
          description: row.workInstructionDetails.description,
          estimatedTime: row.workInstructionDetails.estimatedTime,
          difficulty: row.workInstructionDetails.difficulty,
        }))

        return { workInstructions: workInstructionsList }
      },
    ),
  ),
)

export default app
