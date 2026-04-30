import { useStore } from '../store'

export function AnimateTab() {
  const combinedVideoPath = useStore((s) => s.combinedVideoPath)

  if (!combinedVideoPath) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
        <LockIcon />
        <div>
          <p className="text-zinc-300 font-medium">No combined video yet</p>
          <p className="text-zinc-500 text-sm mt-1">
            Complete the edit in the Edit tab first. Once you render <code className="text-zinc-400">combined.mp4</code>, it will appear here.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8 p-8 h-full overflow-y-auto">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Animate</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Review your cut, then let Claude suggest Hyperframes animations.
        </p>
      </div>

      <section className="flex flex-col gap-3 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
        <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Combined video</h2>
        <video
          src={`file://${combinedVideoPath}`}
          controls
          className="w-full rounded border border-zinc-800 max-h-96"
        />
      </section>

      <div className="mt-auto pt-4 border-t border-zinc-800">
        <button
          disabled
          className="px-5 py-2 rounded bg-violet-600 text-white text-sm font-medium opacity-40 cursor-not-allowed"
          title="Animations available in Phase 5"
        >
          Suggest animations →
        </button>
        <p className="text-xs text-zinc-600 mt-2">Animation planning available in Phase 5.</p>
      </div>
    </div>
  )
}

function LockIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" className="text-zinc-700">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  )
}
