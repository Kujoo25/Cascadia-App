// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * DialogActions — a menu of next steps the assistant proposed.
 *
 * Each action either sends a chat message on the user's behalf or opens a
 * page in the app; an input box sends its template with the typed value
 * filled in. Either way the dialog closes and the conversation carries on
 * from the message that was sent.
 */

import { ArrowRight, ExternalLink, Send } from 'lucide-react'
import { useState } from 'react'
import type { ActionsDialogPayload } from '@cascadia/commons/ai/dialogs'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { toAppRelativeUrl } from '@/markdown/url-transform'

interface DialogActionsProps {
  payload: ActionsDialogPayload
  onNavigate: (url: string) => void
  onSendMessage: (message: string) => void
  onClose: () => void
}

function ActionInput({
  input,
  onSubmit,
}: {
  input: ActionsDialogPayload['inputs'] extends Array<infer T> | undefined
    ? T
    : never
  onSubmit: (message: string) => void
}) {
  const [value, setValue] = useState('')
  const trimmed = value.trim()

  const submit = () => {
    if (!trimmed) return
    onSubmit(input.messageTemplate.replaceAll('{value}', trimmed))
  }

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
        {input.label}
      </label>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={input.placeholder}
        />
        <Button
          type="button"
          onClick={submit}
          disabled={!trimmed}
          className="flex-shrink-0 gap-1.5"
        >
          <Send className="h-3.5 w-3.5" />
          {input.buttonLabel ?? 'Send'}
        </Button>
      </div>
    </div>
  )
}

export function DialogActions({
  payload,
  onNavigate,
  onSendMessage,
  onClose,
}: DialogActionsProps) {
  const send = (message: string) => {
    onClose()
    onSendMessage(message)
  }

  const open = (href: string) => {
    // The server only stores app-relative paths; the same gate the markdown
    // renderer applies keeps that true on the way out as well.
    const url = toAppRelativeUrl(href)
    if (!url) return
    onClose()
    onNavigate(url)
  }

  return (
    <div className="space-y-4">
      {payload.description && (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {payload.description}
        </p>
      )}

      {payload.actions.length > 0 && (
        <div className="space-y-2">
          {payload.actions.map((action, index) => {
            const navigates = Boolean(action.href) && !action.message
            return (
              <button
                key={index}
                type="button"
                title={action.message}
                onClick={() =>
                  action.message
                    ? send(action.message)
                    : action.href && open(action.href)
                }
                className="flex w-full items-center gap-3 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-left transition-colors hover:border-cyan-400 hover:bg-cyan-50 focus:outline-none focus:ring-2 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-cyan-500 dark:hover:bg-cyan-900/20"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {action.label}
                  </div>
                  {action.description && (
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {action.description}
                    </div>
                  )}
                </div>
                {navigates ? (
                  <ExternalLink className="h-4 w-4 flex-shrink-0 text-slate-400" />
                ) : (
                  <ArrowRight className="h-4 w-4 flex-shrink-0 text-slate-400" />
                )}
              </button>
            )
          })}
        </div>
      )}

      {payload.inputs && payload.inputs.length > 0 && (
        <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-700">
          {payload.inputs.map((input, index) => (
            <ActionInput key={index} input={input} onSubmit={send} />
          ))}
        </div>
      )}
    </div>
  )
}
