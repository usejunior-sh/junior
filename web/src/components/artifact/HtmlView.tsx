import { useState } from 'react'
import * as Switch from '@radix-ui/react-switch'
import { ShieldCheck, TriangleAlert } from 'lucide-react'
import { artifactRawUrl } from '../../artifactsClient.js'

/**
 * An html artifact in a sandboxed frame. The raw route already answers with a
 * CSP `sandbox`, and the frame adds its own: no `allow-same-origin` ever, so
 * the page is an opaque origin that cannot reach /api. Scripts are off until
 * the switch is flipped, and even then the page has no network (connect-src
 * 'none' on the server side).
 */
export function HtmlView({ id, version, title, byModel }: { id: string; version: number; title: string; byModel: boolean }) {
  const [scripts, setScripts] = useState(false)
  return (
    <div className="artHtml">
      <div className={`artHtmlBar${scripts ? ' on' : ''}`}>
        {scripts ? <TriangleAlert size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
        <p>
          {scripts
            ? `Scripts are on. ${byModel ? 'Junior wrote this page' : 'This is a file you added'}, and it still cannot reach your data.`
            : 'Preview with scripts off. The page cannot reach your data.'}
        </p>
        <label className="artHtmlRun" title="Turn scripts on only if you trust the page">
          <span>Run scripts</span>
          <Switch.Root className="uiSwitch" checked={scripts} onCheckedChange={setScripts} aria-label="Run scripts">
            <Switch.Thumb className="uiSwitchThumb" />
          </Switch.Root>
        </label>
      </div>
      {/* keyed on the switch: a frame whose sandbox changes must load again, not keep running */}
      <iframe
        key={`${version}:${scripts}`}
        className="artHtmlFrame"
        title={title}
        src={artifactRawUrl(id, { v: version, scripts })}
        sandbox={scripts ? 'allow-scripts' : ''}
        referrerPolicy="no-referrer"
      />
    </div>
  )
}
