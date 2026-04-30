import { useState } from 'react'
import type { ClipMeta } from '@shared/types'

interface Props {
  label: string
  roll: 'a' | 'b'
  folder: string | null
  clips: ClipMeta[]
  isScanning: boolean
  onPick: (folder: string, clips: ClipMeta[]) => void
}

export function FolderPicker({ label, roll, folder, clips, isScanning, onPick }: Props) {
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setError(null)
    const picked = await window.api.pickFolder(roll === 'a' ? 'aroll' : 'broll')
    if (!picked) return
    try {
      const scanned = await window.api.scanFolder(picked, roll)
      onPick(picked, scanned)
    } catch (e) {
      setError(String(e))
    }
  }

  const warnings = clips.filter((c) => c.warning)
  const voiceMismatch = clips.filter((c) => {
    if (roll === 'a') return !c.hasVoice
    return c.hasVoice
  })

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-xs font-mono text-zinc-400 uppercase tracking-widest w-20">
          {label}
        </span>
        <button
          onClick={handleClick}
          disabled={isScanning}
          className="flex items-center gap-2 px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-sm text-zinc-200 transition-colors disabled:opacity-40"
        >
          <FolderIcon />
          {folder ? 'Change folder' : 'Select folder'}
        </button>
        {folder && (
          <span className="text-xs text-zinc-500 truncate max-w-xs" title={folder}>
            {folder.split('/').slice(-2).join('/')}
          </span>
        )}
      </div>

      {folder && clips.length === 0 && !isScanning && (
        <p className="text-xs text-yellow-400 ml-24">No video files found in this folder.</p>
      )}

      {clips.length > 0 && (
        <div className="ml-24 flex flex-col gap-1">
          <p className="text-xs text-zinc-500">
            {clips.length} clip{clips.length !== 1 ? 's' : ''} —{' '}
            {formatDuration(clips.reduce((s, c) => s + c.duration, 0))} total
          </p>
          {voiceMismatch.length > 0 && (
            <p className="text-xs text-yellow-400">
              ⚠ {voiceMismatch.length} clip{voiceMismatch.length !== 1 ? 's' : ''}{' '}
              {roll === 'a'
                ? 'may not contain voice — double-check A-roll selection'
                : 'appear to contain voice — may be mislabeled as B-roll'}
            </p>
          )}
          {warnings.map((c) => (
            <p key={c.path} className="text-xs text-red-400">
              ⚠ {c.path.split('/').pop()}: {c.warning}
            </p>
          ))}
        </div>
      )}

      {error && (
        <p className="text-xs text-red-400 ml-24">Error: {error}</p>
      )}
    </div>
  )
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  )
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s}s`
}
