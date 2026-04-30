import { useEffect } from 'react'
import { useStore } from './store'
import { EditTab } from './tabs/EditTab'
import { AnimateTab } from './tabs/AnimateTab'
import { SettingsTab } from './tabs/SettingsTab'
import { DEFAULT_SETTINGS } from '@shared/types'

export function App() {
  const { activeTab, setActiveTab, setSettings, setSettingsLoaded } = useStore()

  // Load settings on mount
  useEffect(() => {
    async function init() {
      try {
        const s = await window.api.getSettings()
        setSettings({ ...DEFAULT_SETTINGS, ...(s as object) })
      } catch {
        setSettings(DEFAULT_SETTINGS)
      }
      setSettingsLoaded(true)
    }
    init()
  }, [])

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 overflow-hidden select-none">
      {/* Traffic-light drag region + sidebar */}
      <aside className="flex flex-col w-52 bg-zinc-900 border-r border-zinc-800 shrink-0">
        {/* macOS traffic light spacer */}
        <div className="h-10 app-drag" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

        <nav className="flex flex-col gap-1 px-3 mt-1">
          <NavItem id="edit" active={activeTab === 'edit'} onClick={() => setActiveTab('edit')}>
            <EditIcon />
            Edit
          </NavItem>
          <NavItem id="animate" active={activeTab === 'animate'} onClick={() => setActiveTab('animate')}>
            <AnimateIcon />
            Animate
          </NavItem>
        </nav>

        <div className="mt-auto px-3 mb-4">
          <NavItem id="settings" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')}>
            <SettingsIcon />
            Settings
          </NavItem>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        {activeTab === 'edit' && <EditTab />}
        {activeTab === 'animate' && <AnimateTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </main>
    </div>
  )
}

function NavItem({
  id, active, onClick, children
}: {
  id: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      key={id}
      onClick={onClick}
      className={`flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-colors w-full text-left ${
        active
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
      }`}
    >
      {children}
    </button>
  )
}

function EditIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  )
}

function AnimateIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  )
}
