import * as Switch from '@radix-ui/react-switch'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useModelStore, saveModelPrefs, reloadModels, findModel } from '../../models.js'
import { Row, Section } from './shared.js'

// ---------------------------------------------------------------------------
// Models — which models the pickers offer, and ids Claude Code doesn't list.
// ---------------------------------------------------------------------------

export function ModelsTab() {
  const { catalog, hidden, custom, status, error } = useModelStore()
  const [draft, setDraft] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const hiddenSet = new Set(hidden)

  const save = async (patch: Parameters<typeof saveModelPrefs>[0]) => setMsg(await saveModelPrefs(patch))
  const toggle = (id: string, show: boolean) =>
    save({ hiddenModels: show ? hidden.filter((h) => h !== id) : [...hidden, id] })
  const refresh = async () => {
    setBusy(true)
    await reloadModels(true)
    setBusy(false)
  }
  const addCustom = async () => {
    const id = draft.trim()
    if (!id) return
    if (findModel(catalog, id) || custom.includes(id)) return setMsg(`“${id}” is already in the list.`)
    await save({ customModels: [...custom, id] })
    setDraft('')
  }

  return (
    <>
      <Section
        title="Shown in the model picker"
        hint="Turn off the models you never use. A hidden model stays available to a session already on it, and models Claude Code adds later show up on their own."
      >
        {status === 'error' && (
          <div className="msg error">
            Could not load Claude Code’s model list{error ? `: ${error}` : ''}.
            {catalog.length > 0 && ' Showing the last list that loaded.'}
          </div>
        )}
        {catalog.map((m) => (
          <Row key={m.id} label={m.name} hint={m.description}>
            <Switch.Root
              className="uiSwitch"
              checked={!hiddenSet.has(m.id)}
              onCheckedChange={(on) => void toggle(m.id, on)}
              aria-label={`Show ${m.name} in the model picker`}
            >
              <Switch.Thumb className="uiSwitchThumb" />
            </Switch.Root>
          </Row>
        ))}
        <Row label="Model list" hint="Asked of Claude Code itself, so it follows the installed SDK. Check again after updating it.">
          <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={13} aria-hidden="true" /> {busy ? 'Checking…' : 'Check again'}
          </button>
        </Row>
      </Section>
      <Section
        title="Custom model ids"
        hint="For a model Claude Code doesn’t list yet, e.g. claude-opus-5-5. It is passed to Claude Code as typed, with no effort control."
      >
        {custom.map((id) => (
          <Row key={id} label={id}>
            <Switch.Root
              className="uiSwitch"
              checked={!hiddenSet.has(id)}
              onCheckedChange={(on) => void toggle(id, on)}
              aria-label={`Show ${id} in the model picker`}
            >
              <Switch.Thumb className="uiSwitchThumb" />
            </Switch.Root>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void save({ customModels: custom.filter((c) => c !== id), hiddenModels: hidden.filter((h) => h !== id) })}
            >
              Remove
            </button>
          </Row>
        ))}
        <Row label="Add a model id">
          <input
            className="setNum"
            style={{ width: 240 }}
            placeholder="claude-opus-5-5"
            value={draft}
            aria-label="Custom model id"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addCustom()}
          />
          <button type="button" className="btn" disabled={!draft.trim()} onClick={() => void addCustom()}>
            Add
          </button>
        </Row>
        {msg && <div className="msg error">{msg}</div>}
      </Section>
    </>
  )
}
