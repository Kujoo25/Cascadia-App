// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import ExcelJS from 'exceljs'
import type { ItemFieldConfig } from '@cascadia/commons/import/field-configs/types'
import { ValidationError } from '@/errors'

/** The two shapes a sheet downloads as. */
export type SheetFormat = 'csv' | 'xlsx'

export function parseSheetFormat(
  format: string | null | undefined,
): SheetFormat {
  if (!format || format === 'csv') return 'csv'
  if (format === 'xlsx') return 'xlsx'
  throw new ValidationError(`Unsupported sheet format: ${format}`)
}

function escapeCsv(value: string): string {
  return value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
    ? `"${value.replace(/"/g, '""')}"`
    : value
}

/**
 * A CSV document with the fields' labels as its header, one row per record.
 * The header is what the import's column mapper recognises first, so a sheet
 * written here maps itself on the way back in.
 */
export function csvDocument(
  fields: Array<ItemFieldConfig>,
  rows: Array<Record<string, string>>,
): string {
  const lines = [fields.map((field) => escapeCsv(field.label)).join(',')]
  for (const row of rows) {
    lines.push(
      fields.map((field) => escapeCsv(row[field.field] ?? '')).join(','),
    )
  }
  return lines.join('\n')
}

/** The same document as an XLSX workbook, one sheet, bold header. */
export async function xlsxDocument(
  fields: Array<ItemFieldConfig>,
  rows: Array<Record<string, string>>,
  sheetName: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet(sheetName)
  worksheet.columns = fields.map((field) => ({
    header: field.label,
    key: field.field,
    width: Math.max(field.label.length + 4, 15),
  }))
  worksheet.getRow(1).font = { bold: true }
  for (const row of rows) {
    const values: Record<string, string> = {}
    for (const field of fields) values[field.field] = row[field.field] ?? ''
    worksheet.addRow(values)
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

/** A download of `rows` under `fields`, as CSV or XLSX. */
export async function sheetResponse(options: {
  fields: Array<ItemFieldConfig>
  rows: Array<Record<string, string>>
  format: SheetFormat
  fileName: string
  sheetName: string
}): Promise<Response> {
  const { fields, rows, format, fileName, sheetName } = options
  if (format === 'xlsx') {
    const buffer = await xlsxDocument(fields, rows, sheetName)
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${fileName}.xlsx"`,
      },
    })
  }
  return new Response(csvDocument(fields, rows), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}.csv"`,
    },
  })
}
