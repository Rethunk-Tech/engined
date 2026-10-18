/** The Map view: the pending config drawn as a Mermaid flowchart, with its source to copy. */
import { computed, useSignalEffect } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { fork } from './api.ts'
import { configMermaid, MAP_COLOURS } from './configMap.ts'
import { ensureSpec, specs, upstreamResolver } from './data.ts'
import { engineKind, parseDoc } from './model.ts'
import { draft } from './store.ts'
import { CopyButton } from './widgets.tsx'

const doc = computed(() => parseDoc(draft.value))
const source = computed(() => {
  const d = doc.value
  return d === undefined
    ? undefined
    : configMermaid(d, upstreamResolver(d), (e) => engineKind(e, specs.value[String(e.id)]?.info))
})

/** mermaid.render wants an element id no earlier render used. */
let renders = 0

const MIN_ZOOM = 0.1
const MAX_ZOOM = 8
const STEP = 1.25
/** Wheel delta that zooms by one STEP; trackpads send many small deltas, a mouse wheel ~100. */
const WHEEL_PER_STEP = 100
/** Never shrink the map below this on a short window. */
const MIN_MAP_PX = 240

interface Pan {
  k: number
  x: number
  y: number
}

function applyPan(box: HTMLElement | null, p: Pan): void {
  if (box !== null) {
    box.style.transform = `translate(${p.x}px, ${p.y}px) scale(${p.k})`
  }
}

function zoomAt(
  box: HTMLElement | null,
  p: Pan,
  factor: number,
  at: { x: number; y: number },
): void {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, p.k * factor))
  p.x = at.x - (at.x - p.x) * (k / p.k)
  p.y = at.y - (at.y - p.y) * (k / p.k)
  p.k = k
  applyPan(box, p)
}

function zoomCentre(
  frame: HTMLElement | null,
  box: HTMLElement | null,
  p: Pan,
  factor: number,
): void {
  if (frame !== null) {
    zoomAt(box, p, factor, { x: frame.clientWidth / 2, y: frame.clientHeight / 2 })
  }
}

function fitPan(frame: HTMLElement | null, box: HTMLElement | null, p: Pan): void {
  if (frame === null || box === null || box.offsetWidth === 0) {
    return
  }
  p.k = Math.min(frame.clientWidth / box.offsetWidth, frame.clientHeight / box.offsetHeight, 1)
  p.x = (frame.clientWidth - box.offsetWidth * p.k) / 2
  p.y = (frame.clientHeight - box.offsetHeight * p.k) / 2
  applyPan(box, p)
}

/** The frame runs from where it starts to the bottom of the window, less the page's own bottom padding. */
function fillHeight(frame: HTMLElement): void {
  const main = frame.closest('main')
  const pad = main === null ? 0 : Number.parseFloat(getComputedStyle(main).paddingBottom)
  const height = innerHeight - frame.getBoundingClientRect().top - pad
  frame.style.height = `${Math.max(MIN_MAP_PX, height)}px`
}

function paintMermaid(job: {
  text: string | undefined
  box: { current: HTMLDivElement | null }
  scratch: { current: HTMLDivElement | null }
  frame: { current: HTMLDivElement | null }
  pan: { current: Pan }
  setError: (v: string | undefined) => void
  setDrawn: (v: boolean) => void
}): (() => void) | undefined {
  const { text, box, scratch, frame, pan, setError, setDrawn } = job
  if (text === undefined) {
    return
  }
  let current = true
  // Loaded on first use: the library is most of the UI's weight and only this view draws with it.
  import('mermaid')
    .then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
      })
      renders += 1
      // Mermaid lays the chart out in a temporary element; without a container it appends one to the page body.
      const { svg } = await mermaid.render(
        `config-map-${renders}`,
        text,
        scratch.current ?? undefined,
      )
      if (current && box.current !== null) {
        box.current.innerHTML = svg
        // Mermaid sizes its svg to the container; the pan/zoom transform needs its natural size.
        const chart = box.current.querySelector('svg')
        if (chart !== null) {
          chart.setAttribute('width', String(chart.viewBox.baseVal.width))
          chart.setAttribute('height', String(chart.viewBox.baseVal.height))
          chart.style.maxWidth = 'none'
        }
        fitPan(frame.current, box.current, pan.current)
        setError(undefined)
        setDrawn(true)
      }
    })
    .catch((e: unknown) => {
      if (current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  return () => {
    current = false
  }
}

export function MapView() {
  const frame = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const scratch = useRef<HTMLDivElement>(null)
  const [drawn, setDrawn] = useState(false)
  const pan = useRef<Pan>({ k: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number } | undefined>(undefined)
  const [error, setError] = useState<string>()
  useEffect(() => {
    const f = frame.current
    if (f === null) {
      return
    }
    const resize = () => {
      fillHeight(f)
      fitPan(f, box.current, pan.current)
    }
    // Registered by hand: a wheel listener must be non-passive to stop the page scrolling.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = f.getBoundingClientRect()
      zoomAt(box.current, pan.current, STEP ** (-e.deltaY / WHEEL_PER_STEP), {
        x: e.clientX - r.left,
        y: e.clientY - r.top,
      })
    }
    fillHeight(f)
    f.addEventListener('wheel', onWheel, { passive: false })
    addEventListener('resize', resize)
    return () => {
      f.removeEventListener('wheel', onWheel)
      removeEventListener('resize', resize)
    }
  }, [])
  useEffect(() => {
    for (const e of doc.value?.engine ?? []) {
      fork(ensureSpec(String(e.id)))
    }
  }, [])
  useSignalEffect(() =>
    paintMermaid({ text: source.value, box, scratch, frame, pan, setError, setDrawn }),
  )
  const text = source.value
  if (text === undefined) {
    return (
      <p className="bad">The pending text is not valid TOML; fix it on the Raw TOML view first.</p>
    )
  }
  return (
    <section>
      {error === undefined ? null : <p className="bad">{error}</p>}
      <div className="map-wrap">
        <div
          ref={frame}
          className="panel map"
          onPointerDown={(e) => {
            drag.current = { x: e.clientX - pan.current.x, y: e.clientY - pan.current.y }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (drag.current !== undefined) {
              pan.current.x = e.clientX - drag.current.x
              pan.current.y = e.clientY - drag.current.y
              applyPan(box.current, pan.current)
            }
          }}
          onPointerUp={() => {
            drag.current = undefined
          }}
        >
          {drawn || error !== undefined ? null : <p className="muted pad">Drawing…</p>}
          <div ref={box} className="map-canvas" />
          <div ref={scratch} className="map-scratch" />
        </div>
        {/* A sibling, not a child: the frame captures the pointer to drag and would swallow these clicks. */}
        <ul className="map-legend">
          {(
            [
              ['Chain', MAP_COLOURS.chain],
              ['Engine', MAP_COLOURS.engine],
              ['Upstream', MAP_COLOURS.upstream],
            ] as const
          ).map(([name, colour]) => (
            <li key={name}>
              <span className="swatch" style={{ background: `${colour}26`, borderColor: colour }} />
              {name}
            </li>
          ))}
          <li>
            <span className="swatch off" />
            Disabled
          </li>
        </ul>
        <span className="group map-tools">
          <button
            type="button"
            className="small"
            onClick={() => zoomCentre(frame.current, box.current, pan.current, STEP)}
          >
            Zoom in
          </button>
          <button
            type="button"
            className="small"
            onClick={() => zoomCentre(frame.current, box.current, pan.current, 1 / STEP)}
          >
            Zoom out
          </button>
          <button
            type="button"
            className="small"
            onClick={() => fitPan(frame.current, box.current, pan.current)}
          >
            Fit
          </button>
          <CopyButton text={text} title="Copy the Mermaid source" />
        </span>
      </div>
    </section>
  )
}
