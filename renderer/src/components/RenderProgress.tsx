interface Props {
  label: string
  progress: number   // 0–1
  error?: string
  detail?: string
}

export function RenderProgress({ label, progress, error, detail }: Props) {
  const pct = Math.round(progress * 100)

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className={error ? 'text-red-400' : 'text-zinc-400'}>{label}</span>
        {!error && <span className="text-zinc-600 tabular-nums">{pct}%</span>}
      </div>
      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-150 ${
            error ? 'bg-red-500' : progress >= 1 ? 'bg-green-500' : 'bg-blue-500'
          }`}
          style={{ width: `${error ? 100 : pct}%` }}
        />
      </div>
      {(error || detail) && (
        <p className={`text-xs ${error ? 'text-red-400' : 'text-zinc-600'}`}>
          {error ?? detail}
        </p>
      )}
    </div>
  )
}
