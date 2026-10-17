/** The Map view: the pending config drawn as a Mermaid flowchart, with its source to copy. */
import { computed, useSignalEffect } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { configMermaid } from './configMap.ts'
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

export function MapView() {
  const frame = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const view = useRef({ k: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number } | undefined>(undefined)
  const [error, setError] = useState<string>()
  const apply = () => {
    const { k, x, y } = view.current
    if (box.current !== null) {
      box.current.style.transform = `translate(${x}px, ${y}px) scale(${k})`
    }
  }
  const zoomAt = (factor: number, px: number, py: number) => {
    const v = view.current
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor))
    v.x = px - (px - v.x) * (k / v.k)
    v.y = py - (py - v.y) * (k / v.k)
    v.k = k
    apply()
  }
  const zoomCentre = (factor: number) => {
    const f = frame.current
    if (f !== null) {
      zoomAt(factor, f.clientWidth / 2, f.clientHeight / 2)
    }
  }
  const fit = () => {
    const f = frame.current
    const b = box.current
    if (f === null || b === null || b.offsetWidth === 0) {
      return
    }
    const k = Math.min(f.clientWidth / b.offsetWidth, f.clientHeight / b.offsetHeight, 1)
    view.current = {
      k,
      x: (f.clientWidth - b.offsetWidth * k) / 2,
      y: (f.clientHeight - b.offsetHeight * k) / 2,
    }
    apply()
  }
  useEffect(() => {
    const f = frame.current
    if (f === null) {
      return
    }
    // Registered by hand: a wheel listener must be non-passive to stop the page scrolling.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = f.getBoundingClientRect()
      zoomAt(STEP ** (-e.deltaY / WHEEL_PER_STEP), e.clientX - r.left, e.clientY - r.top)
    }
    f.addEventListener('wheel', onWheel, { passive: false })
    return () => f.removeEventListener('wheel', onWheel)
  })
  useEffect(() => {
    for (const e of doc.value?.engine ?? []) {
      void ensureSpec(String(e.id))
    }
  }, [])
  useSignalEffect(() => {
    const text = source.value
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
        const { svg } = await mermaid.render(`config-map-${renders}`, text)
        if (current && box.current !== null) {
          box.current.innerHTML = svg
          // Mermaid sizes its svg to the container; the pan/zoom transform needs its natural size.
          const drawn = box.current.querySelector('svg')
          if (drawn !== null) {
            drawn.setAttribute('width', String(drawn.viewBox.baseVal.width))
            drawn.setAttribute('height', String(drawn.viewBox.baseVal.height))
            drawn.style.maxWidth = 'none'
          }
          fit()
          setError(undefined)
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
  })
  const text = source.value
  if (text === undefined) {
    return <p class="bad">The pending text is not valid TOML; fix it on the Raw TOML view first.</p>
  }
  return (
    <section>
      <div class="rowhead">
        <p class="muted">
          Chains reach engines through their hops; engines reach upstreams through their routes.
          Dashed entries are disabled. This is the pending config, unsaved edits included.
        </p>
        <span class="grow" />
        <span class="group">
          <button type="button" class="small" onClick={() => zoomCentre(STEP)}>
            Zoom in
          </button>
          <button type="button" class="small" onClick={() => zoomCentre(1 / STEP)}>
            Zoom out
          </button>
          <button type="button" class="small" onClick={fit}>
            Fit
          </button>
          <CopyButton text={text} label="Copy Mermaid" />
        </span>
      </div>
      {error === undefined ? null : <p class="bad">{error}</p>}
      <div
        ref={frame}
        class="panel map"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX - view.current.x, y: e.clientY - view.current.y }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (drag.current !== undefined) {
            view.current.x = e.clientX - drag.current.x
            view.current.y = e.clientY - drag.current.y
            apply()
          }
        }}
        onPointerUp={() => {
          drag.current = undefined
        }}
      >
        <div ref={box} class="map-canvas" />
      </div>
    </section>
  )
}
