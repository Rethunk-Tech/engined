/**
 * Published context windows for providers whose `/models` rows state none,
 * keyed by `base_url` host and matched on the model id, first rule wins. The
 * last resort below a declared `context_in` and the provider's own row: a
 * model no rule names reports no window rather than a guessed one.
 */

import type { Upstream } from './types.ts'

/** Ids that share a chat family's prefix but not its window. */
const NOT_CHAT_RE = /image|audio|realtime|tts|transcribe|embed|search/

const KNOWN = new Map<string, ReadonlyArray<readonly [RegExp, number]>>([
  [
    'api.openai.com',
    [
      [/^gpt-5\.2-chat/, 128_000],
      [/^gpt-5\.4-(mini|nano)/, 400_000],
      [/^gpt-(6|5\.[4-9])/, 1_050_000],
      [/^gpt-5/, 400_000],
      [/^gpt-4\.1/, 1_047_576],
      [/^gpt-4o|^gpt-4-turbo/, 128_000],
      [/^o[134](-|$)/, 200_000],
    ],
  ],
  ['api.deepseek.com', [[/^deepseek-(flash|v4)/, 1_000_000]]],
  ['generativelanguage.googleapis.com', [[/^(models\/)?gemini-[\d.]+-(pro|flash)/, 1_048_576]]],
])

export function knownContextIn(upstream: Upstream | undefined, model: string): number | undefined {
  if (upstream?.base_url === undefined || NOT_CHAT_RE.test(model)) {
    return
  }
  const host = URL.parse(upstream.base_url)?.hostname ?? ''
  return KNOWN.get(host)?.find(([re]) => re.test(model))?.[1]
}
