// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ChatDialog — the modal behind a dialog button in the chat panel.
 *
 * Given the descriptor a tool result carried, fetches the stored payload and
 * renders the view for its kind: a results grid, a graph, a form, or a list
 * of suggested actions. Grids and graphs get a near-full-viewport shell;
 * forms and actions the standard centred one. Navigation and messages sent
 * from inside a view close the dialog first, so the conversation is what the
 * user lands back on.
 */

import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2, X } from 'lucide-react'
import { DIALOG_KIND_META } from './dialog-kinds'
import { DialogActions } from './DialogActions'
import { DialogDataGrid } from './DialogDataGrid'
import { DialogForm } from './DialogForm'
import { DialogGraph } from './DialogGraph'
import type {
  ChatDialogDescriptor,
  ChatDialog as ChatDialogRecord,
} from '@cascadia/commons/ai/dialogs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/Dialog'
import { aiDialogQuery } from '@/query'

interface ChatDialogProps {
  /** The dialog to show, or null for none. */
  descriptor: ChatDialogDescriptor | null
  onClose: () => void
  onNavigate: (url: string) => void
  /** Send a message into the conversation as the user. */
  onSendMessage: (message: string) => void
}

/** One line under the title, for the kinds whose payload has a size. */
function subtitleOf(dialog: ChatDialogRecord | undefined): string | undefined {
  if (!dialog) return undefined
  const rows = (n: number) => `${n.toLocaleString('en-US')} rows`
  switch (dialog.kind) {
    case 'data-grid':
      return dialog.payload.truncated
        ? `Showing the first ${rows(dialog.payload.rows.length)} of ${dialog.payload.total.toLocaleString('en-US')}`
        : rows(dialog.payload.rows.length)
    case 'graph':
      return dialog.payload.truncated && dialog.payload.total !== undefined
        ? `Showing ${dialog.payload.nodes.length} of ${dialog.payload.total + 1} items`
        : `${dialog.payload.nodes.length} items`
    default:
      return undefined
  }
}

function DialogBody({
  dialog,
  isLoading,
  isError,
  onClose,
  onNavigate,
  onSendMessage,
}: {
  dialog: ChatDialogRecord | undefined
  isLoading: boolean
  isError: boolean
} & Omit<ChatDialogProps, 'descriptor'>) {
  if (isLoading) {
    return (
      <div className="flex h-full min-h-32 items-center justify-center text-slate-500">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    )
  }
  if (isError || !dialog) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
        <AlertCircle className="h-4 w-4 flex-shrink-0" />
        <span>This dialog could not be loaded. It may have been deleted.</span>
      </div>
    )
  }

  const navigate = (url: string) => {
    onClose()
    onNavigate(url)
  }

  switch (dialog.kind) {
    case 'data-grid':
      return <DialogDataGrid payload={dialog.payload} onNavigate={navigate} />
    case 'graph':
      return <DialogGraph payload={dialog.payload} onNavigate={navigate} />
    case 'form':
      return (
        <DialogForm
          title={dialog.title}
          payload={dialog.payload}
          onSubmit={(message) => {
            onClose()
            onSendMessage(message)
          }}
          onCancel={onClose}
        />
      )
    case 'actions':
      return (
        <DialogActions
          payload={dialog.payload}
          onNavigate={navigate}
          onSendMessage={onSendMessage}
          onClose={onClose}
        />
      )
  }
}

export function ChatDialog({
  descriptor,
  onClose,
  onNavigate,
  onSendMessage,
}: ChatDialogProps) {
  const { data, isLoading, isError } = useQuery(aiDialogQuery(descriptor?.id))

  if (!descriptor) return null

  const meta = DIALOG_KIND_META[descriptor.kind]
  const subtitle = subtitleOf(data)
  const body = (
    <DialogBody
      dialog={data}
      isLoading={isLoading}
      isError={isError}
      onClose={onClose}
      onNavigate={onNavigate}
      onSendMessage={onSendMessage}
    />
  )
  const handleOpenChange = (open: boolean) => {
    if (!open) onClose()
  }

  if (meta.large) {
    return (
      <Dialog open onOpenChange={handleOpenChange}>
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Content
            className="fixed inset-3 z-50 flex flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 dark:border-slate-800 dark:bg-slate-950 md:inset-8"
            aria-describedby={subtitle ? undefined : ''}
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
              <div className="min-w-0">
                <DialogTitle className="flex items-center gap-2">
                  <meta.Icon className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
                  <span className="truncate">{descriptor.title}</span>
                </DialogTitle>
                {subtitle && (
                  <DialogDescription className="mt-1">
                    {subtitle}
                  </DialogDescription>
                )}
              </div>
              <DialogPrimitive.Close className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:ring-offset-2">
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </DialogPrimitive.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden p-4">{body}</div>
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto auto-hide-scroll sm:max-w-xl"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <meta.Icon className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
            {descriptor.title}
          </DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  )
}
