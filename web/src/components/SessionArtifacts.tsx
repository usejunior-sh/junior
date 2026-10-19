/**
 * What this session published, from the chat header: a count and a menu of its
 * artifacts, newest change first. It rides `artifactStore`, so a new file shows
 * up and the count moves while the menu is open. The full list, with filters, is
 * the Artifacts tab, one click away.
 */
import { List } from 'lucide-react'
import { useSessionArtifacts } from '../artifactsClient.js'
import { artifactAgo, FormatIcon } from '../artifactFormat.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'

export function ArtifactsMenu({ sessionId, onNavigate }: { sessionId: string; onNavigate: (hash: string) => void }) {
  const artifacts = useSessionArtifacts(sessionId)
  if (!artifacts.length) return null
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="btn sm ghost artifactsBtn" title="Files Junior published in this session">
          Artifacts <span className="n">{artifacts.length}</span>
        </button>
      </MenuTrigger>
      <MenuContent className="artMenu" align="end">
        <div className="artMenuHead">
          {artifacts.length} {artifacts.length === 1 ? 'artifact' : 'artifacts'} from this session
        </div>
        {artifacts.map((a) => (
          <MenuItem key={a.id} className="artMenuItem" onSelect={() => onNavigate(`/artifact/${a.id}`)}>
            <FormatIcon format={a.format} />
            <span className="name">{a.title}</span>
            <span className="val">
              <span className="ver">v{a.version}</span>
              <span>{artifactAgo(a.updated)}</span>
            </span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem className="artMenuItem foot" onSelect={() => onNavigate(`/artifacts?session=${encodeURIComponent(sessionId)}`)}>
          <List size={14} aria-hidden="true" />
          <span className="name">See in Artifacts</span>
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
