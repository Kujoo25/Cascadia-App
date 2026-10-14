// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * DialogDataGrid — a dialog's rows in the standard DataGrid.
 *
 * The payload names its columns and how each renders; sorting, filtering,
 * search, paging and CSV export come from the grid itself. Link cells and
 * the row context menu navigate to the row's `href`.
 */

import { useMemo } from 'react'
import type { DataGridColumn } from '@/components/ui/DataGrid'
import type {
  DataGridDialogPayload,
  DialogGridColumn,
  DialogGridRow,
} from '@cascadia/commons/ai/dialogs'
import { StateBadge } from '@/components/items/StateBadge'
import { DataGrid } from '@/components/ui/DataGrid'

interface DialogDataGridProps {
  payload: DataGridDialogPayload
  onNavigate: (url: string) => void
}

/** Every row, children included, for deriving filter options. */
function flatten(rows: Array<DialogGridRow>): Array<DialogGridRow> {
  return rows.flatMap((row) => [row, ...flatten(row.children ?? [])])
}

/** Distinct non-empty values of one column, as select-filter options. */
function optionsFor(
  rows: Array<DialogGridRow>,
  columnId: string,
): Array<{ label: string; value: string }> {
  const values = new Set<string>()
  for (const row of rows) {
    const value = row[columnId]
    if (value !== null && value !== undefined && value !== '') {
      values.add(String(value))
    }
  }
  return [...values].sort().map((value) => ({ label: value, value }))
}

/** Columns whose few distinct values make a pick-list filter the right one. */
const CATEGORICAL_COLUMNS = new Set([
  'itemType',
  'state',
  'status',
  'designType',
  'relation',
])

function cellFor(
  column: DialogGridColumn,
  row: DialogGridRow,
  value: unknown,
  onNavigate: (url: string) => void,
) {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)

  switch (column.type) {
    case 'link':
      return row.href ? (
        <button
          type="button"
          onClick={() => row.href && onNavigate(row.href)}
          className="font-medium text-cyan-700 hover:underline dark:text-cyan-400"
        >
          {text}
        </button>
      ) : (
        <span className="font-medium">{text}</span>
      )
    case 'state':
      return text ? <StateBadge itemType={row.itemType} state={text} /> : null
    default:
      return <span>{text}</span>
  }
}

export function DialogDataGrid({ payload, onNavigate }: DialogDataGridProps) {
  const columns = useMemo<Array<DataGridColumn<DialogGridRow>>>(() => {
    const allRows = flatten(payload.rows)
    return payload.columns.map((column) => {
      const categorical =
        column.type === 'state' || CATEGORICAL_COLUMNS.has(column.id)
      return {
        id: column.id,
        header: column.header,
        accessorKey: column.id,
        enableSorting: true,
        enableFiltering: true,
        filterType:
          column.type === 'number'
            ? 'range'
            : categorical
              ? 'multiSelect'
              : 'text',
        filterOptions: categorical ? optionsFor(allRows, column.id) : undefined,
        meta: column.type === 'number' ? { align: 'right' } : undefined,
        cell: ({ row, getValue }) =>
          cellFor(column, row.original, getValue(), onNavigate),
      }
    })
  }, [payload, onNavigate])

  return (
    <div className="h-full overflow-auto auto-hide-scroll">
      <DataGrid
        data={payload.rows}
        columns={columns}
        enableHierarchy={payload.hierarchical}
        getSubRows={payload.hierarchical ? (row) => row.children : undefined}
        enableContextMenu
        getRowUrl={(row) => row.href}
        defaultPageSize={20}
        exportFilename="chat-results"
        emptyMessage="No rows"
        emptyDescription="Nothing matched the filters"
      />
    </div>
  )
}
