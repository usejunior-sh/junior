/**
 * The top bar's Phone button: a popover to let a phone or tablet use this
 * Junior. One switch, then a QR code. The code carries the pairing token
 * (server/remote.ts), so scanning it is the whole sign-in: the Junior iPhone
 * app (ios/) loads the link in its web view, a phone's camera opens it in
 * Safari, and either keeps a cookie afterwards. Managed from the Mac only: a
 * paired phone never sees the button.
 */
import * as Popover from '@radix-ui/react-popover'
import * as RadioGroup from '@radix-ui/react-radio-group'
import * as Switch from '@radix-ui/react-switch'
import { Globe, Smartphone, Wifi } from 'lucide-react'
import qrcode from 'qrcode-generator'
import { useEffect, useMemo, useState } from 'react'
import type { RemoteStatus } from '../../../shared/protocol.js'
import { Select, SelectItem } from '../ui/Select.js'
import { Snippet } from './McpTab.js'

type Local = Extract<RemoteStatus, { local: true }>

const REACH = [
  { id: 'wifi', icon: Wifi, title: 'Same Wi-Fi', body: 'Nothing is exposed to the internet.' },
  { id: 'anywhere', icon: Globe, title: 'Anywhere', body: 'Through a public ngrok address. Only paired phones get in.' },
] as const

/** The QR code as an SVG path: one square per dark module, crisp at any size. */
function QrCode({ text }: { text: string }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`
    return { n, d }
  }, [text])
  // Four modules of quiet zone, as the spec asks; the card is the white.
  return (
    <svg className="phoneQr" viewBox={`-4 -4 ${n + 8} ${n + 8}`} role="img" aria-label="QR code that pairs a phone with this Junior" shapeRendering="crispEdges">
      <rect x={-4} y={-4} width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}

export function PhoneButton() {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [host, setHost] = useState('')

  const enabled = status?.local === true && status.enabled
  const starting = status?.local === true && status.tunnel && status.tunnelStatus.state === 'starting'
  // Read once on load, to know whether this is the Mac at all; then polled only while the
  // popover is open and access is on: a code is single use and short-lived, so the one on
  // screen has to follow the server's, used, expired, or burned.
  useEffect(() => {
    const load = () =>
      void fetch('/api/remote')
        .then((r) => r.json() as Promise<RemoteStatus>)
        .then(setStatus)
        .catch((e) => setError(String(e)))
    load()
    if (!open || !enabled) return
    // Every second while ngrok comes up, so its address lands as soon as it exists.
    const t = setInterval(load, starting ? 1000 : 4000)
    return () => clearInterval(t)
  }, [open, enabled, starting])

  const post = async (body: { enabled?: boolean; rotate?: boolean; newCode?: boolean; tunnel?: boolean }) => {
    setBusy(true)
    setError('')
    try {
      const r = await fetch('/api/remote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      setStatus((await r.json()) as RemoteStatus)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // A paired phone has no business here: access is managed from the Mac.
  if (!status?.local) return null

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`topIcon${open ? ' on' : ''}`}
          title="Connect a phone"
          aria-label="Connect a phone"
        >
          <Smartphone size={15} aria-hidden="true" />
          {status.enabled && <span className="connDot" aria-hidden="true" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="provPop phonePop" side="bottom" align="end" sideOffset={8} collisionPadding={12}>
          <div className="head">
            <span className="lab">Phone</span>
            <span className="win">{status.enabled ? (status.tunnel ? 'on, anywhere' : 'on, same Wi-Fi') : 'off'}</span>
            <Switch.Root
              className="uiSwitch"
              checked={status.enabled}
              disabled={busy}
              onCheckedChange={(on) => void post({ enabled: on })}
              aria-label="Allow other devices"
            >
              <Switch.Thumb className="uiSwitchThumb" />
            </Switch.Root>
          </div>
          {!status.enabled && (
            <p className="phonePopHint">
              Use Junior from your phone. Devices get in only by pairing with this Mac. Switching this off cuts every device at once.
            </p>
          )}
          {status.enabled && (
            <>
              <RadioGroup.Root
                className="reachCards phoneReach"
                aria-label="Where you’ll use it from"
                value={status.tunnel ? 'anywhere' : 'wifi'}
                disabled={busy}
                onValueChange={(v) => void post({ tunnel: v === 'anywhere' })}
              >
                {REACH.map(({ id, icon: Icon, title, body }) => (
                  <RadioGroup.Item key={id} value={id} className="reachCard" title={body}>
                    <span className="reachHead">
                      <span className="reachDot" aria-hidden="true">
                        <RadioGroup.Indicator className="reachDotOn" />
                      </span>
                      <Icon size={14} aria-hidden="true" />
                      {title}
                    </span>
                  </RadioGroup.Item>
                ))}
              </RadioGroup.Root>
              {status.tunnel && <TunnelLine status={status.tunnelStatus} onRetry={() => void post({ tunnel: true })} />}
              <PairSection status={status} host={host} onHost={setHost} onNewCode={() => void post({ newCode: true })} />
              <div className="foot">
                <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void post({ rotate: true })} title="Signs every paired device out and makes a new QR code">
                  Sign out all devices
                </button>
              </div>
            </>
          )}
          {error && <div className="msg error phonePopErr">{error}</div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function PairSection({
  status,
  host,
  onHost,
  onNewCode,
}: {
  status: Local
  host: string
  onHost: (h: string) => void
  onNewCode: () => void
}) {
  // The page's own port: in dev that is Vite's, which proxies on to the daemon.
  const port = location.port ? `:${location.port}` : ''
  const hosts = [...status.addresses.map((a) => a.address), ...(status.hostname ? [status.hostname] : [])]
  const chosen = hosts.includes(host) ? host : hosts[0]
  const ts = status.tunnelStatus
  // Anywhere: the same pairing link, on the tunnel's address. No address picker and no
  // typed code: over the internet only the QR code pairs.
  if (status.tunnel) {
    if (ts.state !== 'up') return null
    return (
      <div className="phonePopPair">
        <div className="phoneQrCard">
          <QrCode text={`${ts.url}/api/pair?token=${encodeURIComponent(status.token)}`} />
        </div>
        <p className="phonePopHint">
          Scan in the Junior iPhone app, on Wi-Fi or mobile data. A camera opens it in Safari instead, where ngrok shows a one-time
          page: tap <b>Visit Site</b>. Keep this Mac awake, or the address stops answering.
        </p>
      </div>
    )
  }
  if (!chosen) return <div className="msg error phonePopErr">This Mac is not on a network right now. Join Wi-Fi, then reopen this.</div>
  const base = `${location.protocol}//${chosen}${port}`
  const pairUrl = `${base}/api/pair?token=${encodeURIComponent(status.token)}`
  return (
    <div className="phonePopPair">
      <div className="phoneQrCard">
        <QrCode text={pairUrl} />
      </div>
      <p className="phonePopHint">
        Scan in the Junior iPhone app, on the same Wi-Fi as this Mac. Nothing loads? Check that macOS Firewall lets <b>node</b>{' '}
        accept incoming connections.
      </p>
      {hosts.length > 1 && (
        <div className="phonePopRow">
          <span title="The .local name survives your router handing this Mac a new IP; some Android phones cannot resolve it.">Address</span>
          <Select className="setSelect" value={chosen} onValueChange={onHost} aria-label="Address the phone connects to">
            {hosts.map((h) => (
              <SelectItem key={h} value={h}>
                {h}
              </SelectItem>
            ))}
          </Select>
        </div>
      )}
      {import.meta.env.DEV && (
        <p className="phonePopHint">
          Dev server: Vite answers the network only when started as <code>JUNIOR_DEV_LAN=1 npm run dev</code>.
        </p>
      )}
      {status.code && <PairCodeBlock code={status.code} onNew={onNewCode} />}
    </div>
  )
}

/** The typeable alternative to the QR code: six digits, grouped for reading aloud, with how long they last. */
function PairCodeBlock({ code, onNew }: { code: { digits: string; expiresAt: number }; onNew: () => void }) {
  const mins = Math.max(1, Math.ceil((code.expiresAt - Date.now()) / 60_000))
  return (
    <div className="phoneCode">
      <span className="cap">or type this code on the phone</span>
      <div className="row">
        <span className="digits" aria-label={`Pairing code ${code.digits.split('').join(' ')}`}>
          {code.digits.slice(0, 3)}
          <span className="gap" aria-hidden="true" />
          {code.digits.slice(3)}
        </span>
        <button type="button" className="btn sm ghost" onClick={onNew}>
          New code
        </button>
      </div>
      <span className="note">Works once · expires in {mins} min · five wrong tries and it is replaced</span>
    </div>
  )
}

/** Where the ngrok tunnel is: coming up, live, or why it is not. */
function TunnelLine({ status, onRetry }: { status: Local['tunnelStatus']; onRetry: () => void }) {
  if (status.state === 'starting')
    return (
      <p className="tunnelLine">
        <span className="dot live" aria-hidden="true" /> Starting ngrok — your public address appears here in a moment…
      </p>
    )
  if (status.state === 'up')
    return (
      <div className="tunnelUp">
        <p className="tunnelLine">
          <span className="dot green" aria-hidden="true" /> Live — this address leads to this Mac from anywhere:
        </p>
        <Snippet label="public address" text={status.url} />
      </div>
    )
  if (status.state === 'error')
    return (
      <div className="msg error">
        {status.error}{' '}
        <button type="button" className="tlink" onClick={onRetry}>
          Try again
        </button>
      </div>
    )
  return null
}
