import { computed, signal } from '@preact/signals'

/** `#view` or `#view/<id>`: the view, and the entry a detail page opens. */
const hash = signal(location.hash.slice(1))
addEventListener('hashchange', () => {
  hash.value = location.hash.slice(1)
})

export const viewId = computed(() => hash.value.split('/')[0] ?? '')

export const viewParam = computed(() => {
  const rest = hash.value.split('/').slice(1).join('/')
  return rest === '' ? undefined : decodeURIComponent(rest)
})
