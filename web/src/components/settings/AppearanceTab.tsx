import * as RadioGroup from '@radix-ui/react-radio-group'
import * as Slider from '@radix-ui/react-slider'
import * as Switch from '@radix-ui/react-switch'
import { Check } from 'lucide-react'
import { type ThemeMode, useAppearance, resolveTheme, FONT_DEFAULT, FONT_MIN, FONT_MAX, writeAppearance, APPEARANCE_DEFAULTS, chooseTheme } from '../../appearance.js'
import { type ThemeScheme, type Theme, findTheme, THEMES } from '../../themes.js'
import { setSettingsTab } from '../../settings.js'
import { Row, Section, Segmented } from './shared.js'

const THEME_OPTS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export function AppearanceTab() {
  const a = useAppearance()
  return (
    <>
      <Section title="Theme">
        <Row label="Colour theme" hint={`${resolveTheme(a).name}${a.mode === 'system' ? ' — following your operating system' : ''}.`}>
          <button type="button" className="btn" onClick={() => setSettingsTab('themes')}>
            Browse themes
          </button>
        </Row>
      </Section>
      <Section
        title="Scale"
        hint="Text size nudges just the reading text. To scale the whole interface, use your browser's zoom (⌘+ / ⌘−)."
      >
        <Row label="Text size" hint={`Body text is ${a.fontSize}px${a.fontSize === FONT_DEFAULT ? ' (default)' : ''}.`}>
          <div className="fontSlider">
            <span className="a sm" aria-hidden="true">A</span>
            <Slider.Root
              className="uiSlider"
              min={FONT_MIN}
              max={FONT_MAX}
              step={1}
              value={[a.fontSize]}
              onValueChange={([fontSize]) => writeAppearance({ fontSize })}
            >
              <Slider.Track className="uiSliderTrack">
                <Slider.Range className="uiSliderRange" />
              </Slider.Track>
              <Slider.Thumb className="uiSliderThumb" aria-label="Text size" />
            </Slider.Root>
            <span className="a lg" aria-hidden="true">A</span>
            <span className="val">{a.fontSize}px</span>
          </div>
        </Row>
      </Section>
      <Section title="Junior page">
        <Row label="Try three tabs" hint="Needs you, With Junior and Waiting. Up next, Reviews and My PRs become filters.">
          <Switch.Root
            className="uiSwitch"
            checked={a.threeTabs}
            onCheckedChange={(threeTabs) => writeAppearance({ threeTabs })}
            aria-label="Try three tabs"
          >
            <Switch.Thumb className="uiSwitchThumb" />
          </Switch.Root>
        </Row>
      </Section>
      <Section title="Reset">
        <Row label="Back to defaults" hint="Junior Dark, default text size, today's tabs.">
          <button type="button" className="btn" onClick={() => writeAppearance(APPEARANCE_DEFAULTS)}>
            Reset
          </button>
        </Row>
      </Section>
    </>
  )
}

// Themes: a gallery per scheme. The mode decides which pick is on screen.

export function ThemesTab() {
  const a = useAppearance()
  const showing = resolveTheme(a)
  return (
    <>
      <Section title="Mode" hint="System follows your operating system’s light or dark setting and switches with it.">
        <Row label="Colour mode">
          <Segmented ariaLabel="Colour mode" value={a.mode} options={THEME_OPTS} onChange={(mode) => writeAppearance({ mode })} />
        </Row>
      </Section>
      <ThemeGallery scheme="dark" value={a.darkTheme} showing={showing} system={a.mode === 'system'} />
      <ThemeGallery scheme="light" value={a.lightTheme} showing={showing} system={a.mode === 'system'} />
    </>
  )
}

function ThemeGallery({
  scheme,
  value,
  showing,
  system,
}: {
  scheme: ThemeScheme
  value: string
  showing: Theme
  system: boolean
}) {
  const title = scheme === 'dark' ? 'Dark themes' : 'Light themes'
  const hint = system
    ? `Your ${scheme} pick shows whenever your operating system is in ${scheme} mode.`
    : showing.scheme === scheme
      ? 'Showing now. Pick one to switch.'
      : `Picking one switches to ${scheme} mode.`
  return (
    <Section title={title} hint={hint}>
      <RadioGroup.Root
        className="themeGrid"
        aria-label={title}
        value={value}
        onValueChange={(id) => {
          const theme = findTheme(id)
          if (theme) chooseTheme(theme)
        }}
      >
        {THEMES.filter((t) => t.scheme === scheme).map((t) => (
          <RadioGroup.Item key={t.id} value={t.id} className="themeCard" data-showing={t.id === showing.id || undefined}>
            <ThemePreview theme={t} />
            <span className="themeName">
              {t.name}
              {t.id === value && <Check size={13} aria-hidden="true" />}
            </span>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
    </Section>
  )
}

/**
 * A thumbnail of the workbench in a theme's own colours, painted from its
 * palette, not the live tokens, so every card shows itself whatever is active.
 */
function ThemePreview({ theme }: { theme: Theme }) {
  const p = theme.palette
  const line = (w: string, color: string) => <i style={{ width: w, background: color }} />
  return (
    <span className="themePreview" style={{ background: p.canvas }} aria-hidden="true">
      <span className="rail" style={{ background: p.card, borderColor: `${p.ink}14` }}>
        {line('70%', p.ink)}
        {line('50%', p.ash)}
        {line('60%', p.ash)}
      </span>
      <span className="main">
        {line('56%', p.ink)}
        {line('84%', p.mute)}
        {line('68%', p.mute)}
        <span className="code" style={{ background: p.deep }}>
          {line('40%', p.purple)}
          {line('62%', p.green)}
        </span>
        <span className="foot">
          <span className="dots">
            {[p.red, p.yellow, p.green, p.blue].map((c, i) => (
              <b key={i} style={{ background: c }} />
            ))}
          </span>
          <span className="btnPill" style={{ background: p.ink }} />
        </span>
      </span>
    </span>
  )
}
