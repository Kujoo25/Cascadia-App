// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { ClipboardList, ListChecks, Table2, Waypoints } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ChatDialogKind } from '@cascadia/commons/ai/dialogs'

/** How each dialog kind presents itself: the button's icon and fallback label. */
export const DIALOG_KIND_META: Record<
  ChatDialogKind,
  { label: string; Icon: LucideIcon; large: boolean }
> = {
  'data-grid': { label: 'View results', Icon: Table2, large: true },
  graph: { label: 'View graph', Icon: Waypoints, large: true },
  form: { label: 'Fill in details', Icon: ClipboardList, large: false },
  actions: { label: 'See suggested actions', Icon: ListChecks, large: false },
}
