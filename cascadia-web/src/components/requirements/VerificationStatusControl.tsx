// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { Loader2, ShieldOff } from 'lucide-react'
import type { Requirement } from '@cascadia/commons/items/types/requirement'
import { apiFetch } from '@/api/client'
import { useResourceMutation } from '@/query'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
} from '@/components/ui'

const STATUS_LABELS: Record<string, string> = {
  NotStarted: 'Not Started',
  InProgress: 'In Progress',
  Passed: 'Passed',
  Failed: 'Failed',
  Waived: 'Waived',
}

const statusVariant = (
  status: string | undefined,
): 'default' | 'secondary' | 'success' | 'warning' | 'destructive' => {
  switch (status) {
    case 'Passed':
      return 'success'
    case 'Failed':
      return 'destructive'
    case 'InProgress':
      return 'default'
    default:
      return 'secondary'
  }
}

/**
 * A requirement's verification status: derived from the latest execution of
 * every test case that verifies it, so there is nothing to edit here — only
 * the one manual exception, a waiver with a note, and the clearing of it.
 * Both are review records rather than design edits, offered whether or not
 * the page is in edit mode; the API charges `requirements:update`.
 */
export function VerificationStatusControl({
  requirement,
}: {
  requirement: Requirement
}) {
  const { handleError } = useErrorHandler()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [note, setNote] = useState('')
  const status = requirement.verificationStatus ?? 'NotStarted'
  const waiver = requirement.verificationWaiver ?? null

  const waive = useResourceMutation({
    mutationFn: (reason: string) =>
      apiFetch(`/api/v1/requirements/${requirement.id}/waive`, {
        method: 'POST',
        body: JSON.stringify({ note: reason }),
      }),
    invalidates: ['requirements', 'items'],
    onSuccess: () => {
      setDialogOpen(false)
      setNote('')
    },
  })
  const clearWaiver = useResourceMutation({
    mutationFn: () =>
      apiFetch(`/api/v1/requirements/${requirement.id}/waive`, {
        method: 'DELETE',
      }),
    invalidates: ['requirements', 'items'],
  })

  const submitWaiver = async () => {
    try {
      await waive.mutateAsync(note.trim())
    } catch (error) {
      handleError(error, { title: 'Could not waive verification' })
    }
  }

  const submitClear = async () => {
    try {
      await clearWaiver.mutateAsync()
    } catch (error) {
      handleError(error, { title: 'Could not clear the waiver' })
    }
  }

  return (
    <div>
      <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
        Verification Status
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={statusVariant(status)}>
          {STATUS_LABELS[status] ?? status}
        </Badge>
        {requirement.id &&
          (waiver ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={submitClear}
              disabled={clearWaiver.isPending}
              title="Let the derived status take over again"
            >
              {clearWaiver.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : null}
              Clear waiver
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDialogOpen(true)}
              title="Record that verification is waived, with the reason"
            >
              <ShieldOff className="h-4 w-4 mr-1" />
              Waive
            </Button>
          ))}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {waiver
          ? `Waived ${new Date(waiver.waivedAt).toLocaleDateString()}: ${waiver.note}`
          : "Derived from the verifying tests' latest executions."}
      </p>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Waive verification</DialogTitle>
            <DialogDescription>
              The status reads Waived until the waiver is cleared, whatever the
              verifying tests say. Say why.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="waiver-note">Reason</Label>
            <Textarea
              id="waiver-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Verified by analysis in report X; no test applies"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={waive.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submitWaiver}
              disabled={waive.isPending || note.trim().length === 0}
            >
              {waive.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : null}
              Waive
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
