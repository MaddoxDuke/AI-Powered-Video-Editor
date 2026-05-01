/**
 * B-roll vision description — extracts a frame from each clip and sends it
 * to Claude Haiku to generate a one-line description. Descriptions are cached
 * in workspace/broll-descriptions.json (keyed by B-roll folder path) so they
 * only run once per clip regardless of which drive the footage lives on.
 */

import { IpcMain, app } from 'electron'
import { join, basename, extname } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import Anthropic from '@anthropic-ai/sdk'
import { extractFrameStrip } from '../pipeline/ffmpeg'
import type { ClipMeta } from '@shared/types'

// ── Cache file lives in workspace/ inside the repo ───────────────────────────

function cacheFilePath(): string {
  // app.getAppPath() returns the repo/app root (where package.json lives)
  const root = app.getAppPath()
  const dir = join(root, 'workspace')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'broll-descriptions.json')
}

/** Full cache: { [folderPath]: { [filename]: description } } */
function loadAllCache(): Record<string, Record<string, string>> {
  const p = cacheFilePath()
  if (!existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, Record<string, string>> }
  catch { return {} }
}

function saveAllCache(all: Record<string, Record<string, string>>): void {
  writeFileSync(cacheFilePath(), JSON.stringify(all, null, 2))
}

function loadCache(folder: string): Record<string, string> {
  return loadAllCache()[folder] ?? {}
}

function saveCache(folder: string, cache: Record<string, string>): void {
  const all = loadAllCache()
  all[folder] = cache
  saveAllCache(all)
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

export function registerBRollDescribeHandlers(ipcMain: IpcMain): void {

  /** Load cached descriptions without running any inference */
  ipcMain.handle('broll:load-descriptions', (_event, folder: string) => {
    return loadCache(folder)
  })

  /**
   * Describe uncached B-roll clips using Claude Haiku vision.
   * Sends progress events: { current, total, clipName }
   * Returns a full map of filename → description for all clips.
   */
  ipcMain.handle(
    'broll:describe',
    async (event, clips: ClipMeta[], folder: string, apiKey: string, force = false) => {
      if (!apiKey) throw new Error('Anthropic API key required for B-roll auto-describe')

      const client = new Anthropic({ apiKey })
      // force = true clears existing descriptions for this folder so all clips are re-described
      const cache = force ? {} : loadCache(folder)

      const toDescribe = clips.filter((c) => {
        if (c.duration < 1.5) return false
        return !cache[basename(c.path)]
      })

      event.sender.send('broll:describe-progress', { current: 0, total: toDescribe.length, clipName: '' })

      for (let i = 0; i < toDescribe.length; i++) {
        const clip = toDescribe[i]
        const name = basename(clip.path)
        event.sender.send('broll:describe-progress', { current: i + 1, total: toDescribe.length, clipName: name })

        const framePath = join(tmpdir(), `ve_strip_${Date.now()}.jpg`)
        try {
          await extractFrameStrip(clip.path, framePath, clip.duration)

          const frameData = readFileSync(framePath).toString('base64')

          const response = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 80,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/jpeg', data: frameData }
                },
                {
                  type: 'text',
                  text: `You are seeing a 3-frame strip (left=start, middle=mid, right=end) of a single video clip. Describe the clip in one short phrase (under 10 words). Focus on the part, action, or detail shown. If a vehicle is identifiable use these details:
- Green NA Miata
- Gray S13 240SX (BMW M52 swap)
- Silver BMW X5 (black interior, HUD)
- Kawasaki Ninja 250R
Append a tag if applicable — only one tag per clip:
- [transition] — clip shows a clear state change (lights on/off, door opening, entering/leaving)
- [timelapse-candidate] — clip shows extended repetitive physical work (grinding, welding, sanding, wrenching) that would benefit from being sped up
Examples: "green Miata engine bay intake side", "gray S13 M52 swap engine bay", "hands torquing Ninja 250 exhaust", "garage lights turning on [transition]", "grinding S13 subframe welds [timelapse-candidate]", "sanding Miata hood for hours [timelapse-candidate]". Reply with the phrase only, no punctuation except the tag.`
                }
              ]
            }]
          })

          const desc = response.content[0].type === 'text'
            ? response.content[0].text.trim().replace(/[.!?]$/, '')
            : basename(clip.path, extname(clip.path))

          cache[name] = desc
          saveCache(folder, cache)
        } catch (err) {
          console.warn(`[broll-describe] failed for ${name}:`, (err as Error).message)
          cache[name] = basename(clip.path, extname(clip.path)).replace(/[_-]/g, ' ')
          saveCache(folder, cache)
        } finally {
          try { if (existsSync(framePath)) unlinkSync(framePath) } catch { /* ignore */ }
        }
      }

      return cache
    }
  )
}
