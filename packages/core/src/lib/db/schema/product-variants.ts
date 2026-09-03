// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  check,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { designs } from './designs'
import { items } from './items'
import { users } from './users'

/**
 * Stable product-family identity. A family belongs to one Design permission
 * boundary, but it is not itself a version container; its Part variants are.
 */
export const partFamilies = pgTable(
  'part_families',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    designId: uuid('design_id')
      .notNull()
      .references(() => designs.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 100 }).notNull(),
    name: varchar('name', { length: 500 }).notNull(),
    description: text('description'),
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    modifiedAt: timestamp('modified_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    modifiedBy: uuid('modified_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    unique('uq_part_families_design_code').on(table.designId, table.code),
    check('ck_part_families_code', sql`${table.code} ~ '^[A-Z0-9][A-Z0-9-]*$'`),
    index('idx_part_families_design').on(table.designId),
  ],
)

/**
 * A Variant is one normal, revisioned Part master. Keeping the association on
 * masterId makes it stable while the ordinary items rows carry R0, R1, ... .
 * masterId cannot be an FK because items intentionally contains many rows for
 * one master and therefore has no unique master_id candidate key.
 */
export const partVariants = pgTable(
  'part_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => partFamilies.id, { onDelete: 'cascade' }),
    partMasterId: uuid('part_master_id').notNull().unique(),
    code: varchar('code', { length: 50 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    unique('uq_part_variants_family_code').on(table.familyId, table.code),
    check('ck_part_variants_code', sql`${table.code} ~ '^V[A-Z0-9-]+$'`),
    index('idx_part_variants_family').on(table.familyId),
  ],
)

/**
 * One MK snapshot for one concrete Part version. executionMasterId remains
 * stable when the row is copied to the next Part revision; the row id changes
 * because its contents belong to that revision. There is deliberately no
 * revision column here — the owning Part is the sole revision authority.
 */
export const partVariantExecutions = pgTable(
  'part_variant_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    executionMasterId: uuid('execution_master_id').notNull().defaultRandom(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => partVariants.id, { onDelete: 'cascade' }),
    partItemId: uuid('part_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 50 }).notNull(),
    name: varchar('name', { length: 500 }),
    sku: varchar('sku', { length: 100 }),
    isActive: boolean('is_active').notNull().default(true),
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    modifiedAt: timestamp('modified_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    modifiedBy: uuid('modified_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    unique('uq_variant_executions_item_code').on(table.partItemId, table.code),
    unique('uq_variant_executions_item_master').on(
      table.partItemId,
      table.executionMasterId,
    ),
    check(
      'ck_part_variant_executions_code',
      sql`${table.code} ~ '^MK[A-Z0-9-]+$'`,
    ),
    index('idx_variant_executions_variant').on(table.variantId),
    index('idx_variant_executions_part_item').on(table.partItemId),
    index('idx_variant_executions_master').on(table.executionMasterId),
  ],
)

/**
 * Execution-specific additions to the common Variant BOM. Removing or
 * replacing a common line needs a stable BOM-line identity, which the current
 * item_relationships model does not have, so this first slice intentionally
 * models additions only.
 */
export const partVariantExecutionBomLines = pgTable(
  'part_variant_execution_bom_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => partVariantExecutions.id, { onDelete: 'cascade' }),
    targetItemId: uuid('target_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    quantity: decimal('quantity', { precision: 10, scale: 3 })
      .notNull()
      .default('1'),
    referenceDesignator: text('reference_designator'),
    findNumber: integer('find_number'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    modifiedAt: timestamp('modified_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    modifiedBy: uuid('modified_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    unique('uq_variant_execution_bom_target').on(
      table.executionId,
      table.targetItemId,
    ),
    index('idx_variant_execution_bom_execution').on(table.executionId),
    index('idx_variant_execution_bom_target').on(table.targetItemId),
  ],
)

export const partFamiliesRelations = relations(
  partFamilies,
  ({ one, many }) => ({
    design: one(designs, {
      fields: [partFamilies.designId],
      references: [designs.id],
    }),
    variants: many(partVariants),
  }),
)

export const partVariantsRelations = relations(
  partVariants,
  ({ one, many }) => ({
    family: one(partFamilies, {
      fields: [partVariants.familyId],
      references: [partFamilies.id],
    }),
    executions: many(partVariantExecutions),
  }),
)

export const partVariantExecutionsRelations = relations(
  partVariantExecutions,
  ({ one, many }) => ({
    variant: one(partVariants, {
      fields: [partVariantExecutions.variantId],
      references: [partVariants.id],
    }),
    partItem: one(items, {
      fields: [partVariantExecutions.partItemId],
      references: [items.id],
    }),
    bomLines: many(partVariantExecutionBomLines),
  }),
)

export const partVariantExecutionBomLinesRelations = relations(
  partVariantExecutionBomLines,
  ({ one }) => ({
    execution: one(partVariantExecutions, {
      fields: [partVariantExecutionBomLines.executionId],
      references: [partVariantExecutions.id],
    }),
    targetItem: one(items, {
      fields: [partVariantExecutionBomLines.targetItemId],
      references: [items.id],
    }),
  }),
)
