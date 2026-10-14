// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { SystemElement } from '@cascadia/commons/items/types/system-element'
import type { SystemElementDetailTab } from '@/components/system-elements/SystemElementDetail'
import {
  SYSTEM_ELEMENT_DETAIL_TABS,
  SystemElementDetail,
} from '@/components/system-elements/SystemElementDetail'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import { entityQuery, useInvalidateResources } from '@/query'
import { apiFetch } from '@/api/client'

// Version-context params + tab. useVersionContext reads and writes
// branch/tag/commit through the URL; validateSearch strips anything the
// schema does not name, so without these a context switch (or a
// revise-checkout navigation) silently lands back on main.
const systemElementDetailSearchSchema = z.object({
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
  tab: z.enum(SYSTEM_ELEMENT_DETAIL_TABS).optional().default('details'),
})

export const Route = createFileRoute('/system-elements/$id')({
  component: SystemElementDetailPage,
  validateSearch: systemElementDetailSearchSchema,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(
      entityQuery<SystemElement>('system-elements', params.id, 'systemElement'),
    ),
})

function SystemElementDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { id } = Route.useParams()
  const { data: element } = useQuery(
    entityQuery<SystemElement>('system-elements', id, 'systemElement'),
  )
  const search = Route.useSearch()

  if (!element) return null

  const handleSave = async (updated: SystemElement) => {
    if (!element.id) return
    await apiFetch(`/api/v1/system-elements/${element.id}`, {
      method: 'PUT',
      body: JSON.stringify(updated),
    })
    showSuccess(
      'System element updated',
      `${updated.itemNumber} has been updated successfully`,
    )
    await invalidate('system-elements')
  }

  const handleDelete = async () => {
    if (!element.id) return
    await apiFetch(`/api/v1/system-elements/${element.id}`, {
      method: 'DELETE',
    })
    showSuccess(
      'System element deleted',
      `${element.itemNumber} has been deleted`,
    )
    await invalidate('system-elements')
    navigate({ to: '/system-elements' })
  }

  const handleCancel = () => {
    navigate({ to: '/system-elements' })
  }

  const handleTabChange = (tab: SystemElementDetailTab) => {
    router.navigate({
      to: '/system-elements/$id',
      params: { id: element.id ?? '' },
      search: {
        ...search,
        tab,
      },
      replace: true,
    })
  }

  return (
    <SystemElementDetail
      element={element}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancel}
      onTransitioned={() => void invalidate('system-elements')}
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
