import { useState } from 'react'

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className="shrink-0 px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 text-xs transition-colors"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
