/** Server-sent events over `fetch`, for the POST streams EventSource cannot open. */

export interface SseFrame {
  event: string
  data: unknown
}

/** Splits a growing text buffer into complete frames and the unfinished tail. */
export function takeFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = []
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? ''
  for (const part of parts) {
    let event = 'message'
    const data: string[] = []
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).trim())
      }
    }
    if (data.length > 0) {
      try {
        frames.push({ event, data: JSON.parse(data.join('\n')) })
      } catch {
        frames.push({ event, data: data.join('\n') })
      }
    }
  }
  return { frames, rest }
}

export async function postStream(
  path: string,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
): Promise<number> {
  const res = await fetch(path, { method: 'POST', signal })
  if (res.body === null) {
    return res.status
  }
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    const failure: unknown = await res.json().catch(() => undefined)
    onFrame({ event: 'error', data: failure })
    return res.status
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      return res.status
    }
    const taken = takeFrames(buffer + value)
    buffer = taken.rest
    for (const frame of taken.frames) {
      onFrame(frame)
    }
  }
}
