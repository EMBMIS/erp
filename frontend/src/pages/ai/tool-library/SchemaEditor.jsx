import React, { useState } from 'react'
import { Textarea } from '../../../components/ui'

/**
 * A schema editor that stays usable while the JSON is half-typed: parsing on
 * every keystroke and reverting would make the field impossible to type into.
 * Takes the id / aria props a surrounding Field passes, so its label works.
 */
export default function SchemaEditor({ value, onChange, id, ...aria }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? { type: 'object', properties: {} }, null, 2))
  const [error, setError] = useState(null)

  const handle = (next) => {
    setText(next)
    try {
      onChange(JSON.parse(next || '{}'))
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <>
      <Textarea
        id={id}
        {...aria}
        aria-invalid={error ? true : undefined}
        value={text}
        onChange={(e) => handle(e.target.value)}
        rows={14}
        spellCheck={false}
        className="font-mono text-xs"
      />
      {error ? (
        <p className="mt-1 text-xs text-risk-600">{error}</p>
      ) : (
        <p className="mt-1 text-xs text-ink-500">Describe each property — Simeli uses the descriptions to fill them in.</p>
      )}
    </>
  )
}
