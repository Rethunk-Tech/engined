import { expect, test } from 'bun:test'
import {
  TRANSLATION_PASS_RECALL,
  TRANSLATION_REFERENCE,
  translationRecall,
  translationVerdict,
} from './probeTranslation.ts'

test('the reference itself scores 1 and passes', () => {
  expect(translationRecall(TRANSLATION_REFERENCE, TRANSLATION_REFERENCE)).toBe(1)
  expect(translationVerdict(TRANSLATION_REFERENCE, TRANSLATION_REFERENCE).ok).toBe(true)
})

test('punctuation and case do not matter, and one inflection miss still passes', () => {
  const v = translationVerdict(
    TRANSLATION_REFERENCE,
    'The Black Cat is sleeping on the wooden table!',
  )
  expect(
    translationRecall(TRANSLATION_REFERENCE, 'The Black Cat is sleeping on the wooden table!'),
  ).toBe(0.8)
  expect(v.ok).toBe(true)
})

test('the recorded wrong English scores 0.4 and fails', () => {
  const wrong = 'The black man sleeps on the bed in the kitchen.'
  expect(translationRecall(TRANSLATION_REFERENCE, wrong)).toBe(0.4)
  expect(translationVerdict(TRANSLATION_REFERENCE, wrong).ok).toBe(false)
})

test('the pass mark is inclusive: exactly three of five content words passes, two fails', () => {
  expect(TRANSLATION_PASS_RECALL).toBe(0.6)
  expect(translationVerdict(TRANSLATION_REFERENCE, 'black cat sleeps').ok).toBe(true)
  expect(translationVerdict(TRANSLATION_REFERENCE, 'black cat').ok).toBe(false)
})

test('empty and repeated replies cannot score by volume', () => {
  expect(translationVerdict(TRANSLATION_REFERENCE, '').ok).toBe(false)
  expect(translationRecall(TRANSLATION_REFERENCE, 'cat cat cat cat cat')).toBe(0.2)
})
