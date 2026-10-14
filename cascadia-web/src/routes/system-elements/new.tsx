// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import type { SystemElement } from '@cascadia/commons/items/types/system-element'
import { SystemElementDetail } from '@/components/system-elements/SystemElementDetail'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import { designListQuery, useInvalidateResources } from '@/query'
import { apiFetch } from '@/api/client'

// The design the element belongs to, the element it is created under (the
// Architecture tab's "add child"), and the branch the tab was viewing — the
// new element lands there, and so does the DECOMPOSES edge from its parent.
const newSystemElementSearchSchema = z.object({
  designId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  branch: z.string().uuid().optional(),
})

export const Route = createFileRoute('/system-elements/new')({
  validateSearch: newSystemElementSearchSchema,
  component: NewSystemElementPage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(designListQuery()),
})

function NewSystemElementPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { data: designs = [] } = useQuery(designListQuery())
  const searchParams = Route.useSearch()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (element: SystemElement, branchId?: string) => {
    setIsSubmitting(true)
    try {
      const payload = {
        ...element,
        itemType: 'SystemElement',
        ...(branchId && { branchId }),
      }
      const result = await apiFetch<{ data: { item: SystemElement } }>(
        '/api/v1/items',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      )
      const created = result.data.item
      // Under a parent: the tree edge, written on the same branch as the
      // element so the two land together.
      if (searchParams.parentId) {
        await apiFetch(
          `/api/v1/system-elements/${searchParams.parentId}/children`,
          {
            method: 'POST',
            body: JSON.stringify({
              itemIds: [created.id],
              ...(branchId && { branchId }),
            }),
          },
        )
      }
      showSuccess(
        'System element created',
        `${created.itemNumber} has been created successfully`,
      )
      await invalidate('system-elements')
      navigate({
        to: '/system-elements/$id',
        params: { id: created.id! },
        search: branchId ? { branch: branchId } : {},
      })
    } catch (error) {
      handleError(error, { title: 'Failed to create system element' })
      throw error
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/system-elements' })
  }

  return (
    <SystemElementDetail
      designs={designs}
      defaultDesignId={searchParams.designId}
      defaultBranchId={searchParams.branch}
      onSave={handleSave}
      onCancel={handleCancel}
      isSubmitting={isSubmitting}
    />
  )
}
