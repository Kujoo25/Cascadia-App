// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type {
  PartVariantConfiguration,
  ResolvedVariantBomLine,
} from '@/lib/product-variants/types'
import { apiFetch } from '@/lib/api/client'

export function partVariantConfigurationQuery(partId: string) {
  return queryOptions({
    queryKey: qk.sub('parts', partId, 'product-variant'),
    queryFn: async (): Promise<PartVariantConfiguration | null> => {
      const response = await apiFetch<{
        data: { configuration: PartVariantConfiguration | null }
      }>(`/api/v1/parts/${partId}/variant-configuration`)
      return response.data.configuration
    },
    enabled: Boolean(partId),
  })
}

export function resolvedVariantBomQuery(
  partId: string,
  executionId: string | null,
) {
  return queryOptions({
    queryKey: qk.sub('parts', partId, 'resolved-variant-bom', {
      executionId,
    }),
    queryFn: async (): Promise<Array<ResolvedVariantBomLine>> => {
      const response = await apiFetch<{
        data: { lines: Array<ResolvedVariantBomLine> }
      }>(
        `/api/v1/parts/${partId}/variant-executions/${executionId}/resolved-bom`,
      )
      return response.data.lines
    },
    enabled: Boolean(partId && executionId),
  })
}
