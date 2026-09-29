// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Copy, Info, Loader2 } from 'lucide-react'
import type { BaseItem } from '@cascadia/commons/items/types/base'
import type { Resource } from '@/query/keys'
import { BranchSelector } from '@/components/versioning/BranchSelector'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@/components/ui'
import { apiFetch } from '@/api/client'
import { designStatusQuery, useInvalidateResources } from '@/query'
import { useErrorHandler } from '@/hooks/useErrorHandler'

type CloneableItemType = 'Part' | 'Document' | 'Requirement' | 'Software'

type CloneableItem = BaseItem & {
  id: string
  designId: string
  itemNumber: string
  itemType: CloneableItemType
  productFamilyCode?: string | null
  variantCode?: string | null
}

const destination: Record<
  CloneableItemType,
  { route: string; resource: Resource }
> = {
  Part: { route: '/parts/$id', resource: 'parts' },
  Document: { route: '/documents/$id', resource: 'documents' },
  Requirement: { route: '/requirements/$id', resource: 'requirements' },
  Software: { route: '/software/$id', resource: 'software' },
}

interface CloneItemDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: CloneableItem
  sourceBranchId?: string
}

interface CloneResponse {
  data: {
    item: {
      id: string
      itemNumber: string
    }
    relationshipsCopied: number
  }
}

/** Shared clone flow for the four design-owned engineering item types. */
export function CloneItemDialog({
  open,
  onOpenChange,
  item,
  sourceBranchId,
}: CloneItemDialogProps) {
  const navigate = useNavigate()
  const invalidate = useInvalidateResources()
  const { handleError, showSuccess } = useErrorHandler()
  const [name, setName] = useState('')
  const [itemNumber, setItemNumber] = useState('')
  const [branchId, setBranchId] = useState<string | undefined>()
  const [copyRelationships, setCopyRelationships] = useState(false)
  const [copyVariants, setCopyVariants] = useState(false)
  const [variantCode, setVariantCode] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const isPart = item.itemType === 'Part'
  const needsNewVariantCode =
    isPart && copyVariants && Boolean(item.productFamilyCode)
  const { data: designStatus } = useQuery(
    designStatusQuery(item.designId, open && Boolean(item.designId)),
  )
  const branchRequired = designStatus?.protection.phase === 'post-release'

  useEffect(() => {
    if (!open) return
    setName(item.name ?? '')
    setItemNumber('')
    setBranchId(sourceBranchId)
    setCopyRelationships(isPart)
    setCopyVariants(isPart)
    setVariantCode('')
    setSubmitting(false)
  }, [open, item, sourceBranchId, isPart])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (branchRequired && !branchId) return
    if (needsNewVariantCode && !variantCode.trim()) return

    setSubmitting(true)
    try {
      const result = await apiFetch<CloneResponse>(
        `/api/v1/items/${item.id}/clone`,
        {
          method: 'POST',
          body: JSON.stringify({
            itemNumber: itemNumber.trim() || undefined,
            name: name.trim() || undefined,
            branchId,
            copyRelationships,
            copyVariants: isPart && copyVariants,
            variantCode:
              needsNewVariantCode && variantCode.trim()
                ? variantCode.trim().toUpperCase()
                : undefined,
          }),
        },
      )

      const target = destination[item.itemType]
      await invalidate(
        target.resource,
        ...(copyRelationships ? (['relationships'] as const) : []),
      )
      onOpenChange(false)
      showSuccess(
        `${item.itemType} cloned`,
        `${result.data.item.itemNumber} was created as a new draft${result.data.relationshipsCopied > 0 ? ` with ${result.data.relationshipsCopied} relationship${result.data.relationshipsCopied === 1 ? '' : 's'}` : ''}.`,
      )
      navigate({
        to: target.route,
        params: { id: result.data.item.id },
        search: branchId ? { branch: branchId } : {},
      } as never)
    } catch (error) {
      handleError(error, { title: `Cannot clone ${item.itemType}` })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={submitting ? undefined : onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="h-5 w-5" />
            Clone {item.itemType}
          </DialogTitle>
          <DialogDescription>
            Create a new independent draft from {item.itemNumber}. Revision
            history, files, checkouts, and ECO membership are not copied.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="clone-item-number">New Item Number</Label>
            <Input
              id="clone-item-number"
              value={itemNumber}
              onChange={(event) => setItemNumber(event.target.value)}
              placeholder="Leave blank for automatic numbering"
              disabled={submitting}
              maxLength={100}
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {isPart
                ? `Blank creates the next family number based on ${item.itemNumber}.`
                : 'Blank uses the configured numbering scheme.'}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="clone-item-name">Name</Label>
            <Input
              id="clone-item-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={submitting}
              maxLength={500}
            />
          </div>

          {needsNewVariantCode && (
            <div className="space-y-2">
              <Label htmlFor="clone-variant-code">New Variant Code</Label>
              <Input
                id="clone-variant-code"
                value={variantCode}
                onChange={(event) =>
                  setVariantCode(event.target.value.toUpperCase())
                }
                placeholder="e.g. V2"
                disabled={submitting}
                required
                maxLength={50}
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                The clone remains in family {item.productFamilyCode}, but must
                have a different code than {item.variantCode}.
              </p>
            </div>
          )}

          <div className="space-y-3 rounded-md border border-slate-200 p-4 dark:border-slate-800">
            <div className="flex items-start gap-2">
              <Checkbox
                id="clone-relationships"
                checked={copyRelationships}
                onCheckedChange={(checked) =>
                  setCopyRelationships(checked === true)
                }
                disabled={submitting}
              />
              <div className="space-y-1">
                <Label htmlFor="clone-relationships">Copy relationships</Label>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Copies outgoing links. For a Part this includes its BOM and
                  keeps the existing component targets.
                </p>
              </div>
            </div>

            {isPart && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="clone-variants"
                  checked={copyVariants}
                  onCheckedChange={(checked) =>
                    setCopyVariants(checked === true)
                  }
                  disabled={submitting}
                />
                <div className="space-y-1">
                  <Label htmlFor="clone-variants">Copy variants</Label>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Copies product-family membership, option model, and
                    executions (MK).
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Target Branch {branchRequired ? '*' : '(optional)'}</Label>
            <BranchSelector
              designId={item.designId}
              value={branchId}
              onChange={setBranchId}
              showMainOption={!branchRequired}
              disabled={submitting}
              placeholder={
                branchRequired ? 'Select branch...' : 'Main branch (default)'
              }
            />
            {branchRequired && !branchId && (
              <div className="flex items-start gap-2 text-sm text-blue-700 dark:text-blue-300">
                <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>
                  Main is protected. Select an ECO or workspace branch for the
                  cloned draft.
                </span>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                submitting ||
                (branchRequired && !branchId) ||
                (needsNewVariantCode && !variantCode.trim())
              }
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cloning...
                </>
              ) : (
                <>
                  <Copy className="mr-2 h-4 w-4" />
                  Clone {item.itemType}
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
