// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

// Types
import { BOM_FIELDS, PART_FIELDS } from './part-fields'
import { DOCUMENT_FIELDS } from './document-fields'
import { ISSUE_FIELDS } from './issue-fields'
import { REQUIREMENT_FIELDS } from './requirement-fields'
import type { ImportTypeConfig, ItemFieldConfig } from './types'

export type { ItemFieldConfig, ImportTypeConfig } from './types'

// Field configurations
export { PART_FIELDS, BOM_FIELDS } from './part-fields'
export { DOCUMENT_FIELDS } from './document-fields'
export { ISSUE_FIELDS } from './issue-fields'
export {
  REQUIREMENT_FIELDS,
  REQUIREMENT_SHEET_FIELDS,
} from './requirement-fields'

/**
 * Registry of all import type configurations
 */
const IMPORT_TYPE_CONFIGS: Record<
  'Part' | 'Document' | 'Issue' | 'Requirement',
  ImportTypeConfig
> = {
  Part: {
    itemType: 'Part',
    fields: PART_FIELDS,
    requiresDesign: true,
    supportsBom: true,
    apiEndpoint: '/api/v1/import/parts',
    singularLabel: 'Part',
    pluralLabel: 'Parts',
  },
  Document: {
    itemType: 'Document',
    fields: DOCUMENT_FIELDS,
    requiresDesign: true,
    supportsBom: false,
    apiEndpoint: '/api/v1/import/documents',
    singularLabel: 'Document',
    pluralLabel: 'Documents',
  },
  Issue: {
    itemType: 'Issue',
    fields: ISSUE_FIELDS,
    requiresDesign: false,
    supportsBom: false,
    apiEndpoint: '/api/v1/import/issues',
    singularLabel: 'Issue',
    pluralLabel: 'Issues',
  },
  Requirement: {
    itemType: 'Requirement',
    fields: REQUIREMENT_FIELDS,
    requiresDesign: true,
    supportsBom: false,
    apiEndpoint: '/api/v1/import/requirements',
    singularLabel: 'Requirement',
    pluralLabel: 'Requirements',
  },
}

/**
 * Get the import configuration for a specific item type
 */
export function getImportConfig(
  itemType: 'Part' | 'Document' | 'Issue' | 'Requirement',
): ImportTypeConfig {
  return IMPORT_TYPE_CONFIGS[itemType]
}

/**
 * Get the fields for a specific item type
 */
export function getFieldsForItemType(
  itemType: 'Part' | 'Document' | 'Issue' | 'Requirement',
): Array<ItemFieldConfig> {
  return IMPORT_TYPE_CONFIGS[itemType].fields
}

/**
 * Get all fields for a specific item type (including BOM fields for Parts)
 */
export function getAllFieldsForItemType(
  itemType: 'Part' | 'Document' | 'Issue' | 'Requirement',
): Array<ItemFieldConfig> {
  const config = IMPORT_TYPE_CONFIGS[itemType]
  if (config.supportsBom) {
    return [...config.fields, ...BOM_FIELDS]
  }
  return config.fields
}

/**
 * Get field config by field name for a specific item type
 */
export function getFieldConfigForType(
  itemType: 'Part' | 'Document' | 'Issue' | 'Requirement',
  field: string,
): ItemFieldConfig | undefined {
  return getAllFieldsForItemType(itemType).find((f) => f.field === field)
}

/**
 * Get required fields for a specific item type
 */
export function getRequiredFieldsForType(
  itemType: 'Part' | 'Document' | 'Issue' | 'Requirement',
): Array<ItemFieldConfig> {
  return getFieldsForItemType(itemType).filter((f) => f.required)
}

/**
 * Get auto-generate fields for a specific item type
 */
export function getAutoGenerateFieldsForType(
  itemType: 'Part' | 'Document' | 'Issue' | 'Requirement',
): Array<ItemFieldConfig> {
  return getFieldsForItemType(itemType).filter((f) => f.autoGenerate)
}
