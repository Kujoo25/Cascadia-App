// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { jsonValueSchema } from '@/lib/items/types/base'

const code = (kind: 'family' | 'variant' | 'execution') => {
  const pattern =
    kind === 'variant'
      ? /^V[A-Z0-9-]+$/
      : kind === 'execution'
        ? /^MK[A-Z0-9-]+$/
        : /^[A-Z0-9][A-Z0-9-]*$/
  const example =
    kind === 'variant' ? 'V1' : kind === 'execution' ? 'MK1' : 'P3001'

  return z
    .string()
    .trim()
    .toUpperCase()
    .min(1)
    .max(kind === 'family' ? 100 : 50)
    .regex(pattern, `${kind} code must look like ${example}`)
}

export const familyCodeSchema = code('family')
export const variantCodeSchema = code('variant')
export const executionCodeSchema = code('execution')

export const configurePartVariantSchema = z.object({
  familyCode: familyCodeSchema,
  familyName: z.string().trim().min(1).max(500),
  familyDescription: z.string().trim().max(5000).optional(),
  variantCode: variantCodeSchema,
})

export const createVariantExecutionSchema = z.object({
  code: executionCodeSchema,
  name: z.string().trim().max(500).optional(),
  sku: z.string().trim().max(100).optional(),
  isActive: z.boolean().optional().default(true),
  attributes: z.record(z.string(), jsonValueSchema).optional().default({}),
})

export const updateVariantExecutionSchema = z
  .object({
    name: z.string().trim().max(500).nullable().optional(),
    sku: z.string().trim().max(100).nullable().optional(),
    isActive: z.boolean().optional(),
    attributes: z.record(z.string(), jsonValueSchema).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one execution field is required',
  })

export const createExecutionBomLineSchema = z.object({
  targetItemId: z.string().uuid(),
  quantity: z
    .union([z.string(), z.number()])
    .transform(String)
    .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, {
      message: 'Quantity must be greater than zero',
    }),
  referenceDesignator: z.string().trim().max(2000).optional(),
  findNumber: z.number().int().min(0).optional(),
})

export type ConfigurePartVariantInput = z.infer<
  typeof configurePartVariantSchema
>
export type CreateVariantExecutionInput = z.infer<
  typeof createVariantExecutionSchema
>
export type UpdateVariantExecutionInput = z.infer<
  typeof updateVariantExecutionSchema
>
export type CreateExecutionBomLineInput = z.infer<
  typeof createExecutionBomLineSchema
>

export interface VariantBomTarget {
  id: string
  masterId: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  designId: string | null
}

export interface ResolvedVariantBomLine {
  id: string
  scope: 'variant' | 'execution'
  executionId?: string
  targetItemId: string
  quantity: string | null
  referenceDesignator: string | null
  findNumber: number | null
  targetItem: VariantBomTarget
}

export interface VariantExecutionView {
  id: string
  executionMasterId: string
  code: string
  name: string | null
  sku: string | null
  isActive: boolean
  attributes: Record<string, unknown>
  designation: string
  bomLines: Array<ResolvedVariantBomLine>
}

export interface PartVariantConfiguration {
  family: {
    id: string
    code: string
    name: string
    description: string | null
  }
  variant: {
    id: string
    code: string
    partMasterId: string
    itemId: string
    revision: string
    baseDesignation: string
  }
  executions: Array<VariantExecutionView>
}

/**
 * The parent Part owns the revision. A working marker is displayed as DRAFT
 * so an unreleased configuration cannot be mistaken for a production code.
 */
export function formatExecutionDesignation(input: {
  familyCode: string
  variantCode: string
  revision: string
  executionCode: string
}): string {
  const revision =
    !input.revision ||
    input.revision === 'DRAFT' ||
    input.revision.startsWith('-')
      ? 'DRAFT'
      : input.revision
  return `${input.familyCode}${input.variantCode}${revision}${input.executionCode}`
}
