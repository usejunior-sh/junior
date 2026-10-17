import { useHashRoute } from '../hooks.js'
import { useOpenTabs } from '../tabs.js'

export type Navigate = ReturnType<typeof useHashRoute>[1]

export type TabsApi = ReturnType<typeof useOpenTabs>
