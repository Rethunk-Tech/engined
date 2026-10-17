import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

test('edit a route field, see validate and the diff, save, and hot reload', async ({ page }) => {
  const configFile = process.env.E2E_CONFIG as string
  const before = readFileSync(configFile, 'utf8').split('\n')

  const faults: string[] = []
  page.on('pageerror', (err) => faults.push(err.message))
  page.on('response', (res) => {
    // A spec-less engine (kind = ...) has no spec.toml to show; that 404 is the answer.
    if (res.status() === 404 && !res.url().includes('/api/spec/')) {
      faults.push(`404 ${res.url()}`)
    }
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('404')) {
      faults.push(msg.text())
    }
  })

  await page.goto(process.env.E2E_URL as string)
  await expect(page.locator('.banner')).toHaveText(/running the saved config/)

  // Every view renders against the example config without a script or CSP error.
  for (const link of await page.locator('nav a').all()) {
    await link.click()
    await expect(page.locator('main h2').first()).toBeVisible()
  }
  expect(faults).toEqual([])

  await page.getByRole('link', { name: 'Engines' }).click()
  const route = page.locator('.route').first()
  await route.getByRole('button', { name: 'Edit' }).click()
  const field = route.locator('.field:has(.fieldname:text-is("display_name")) input')
  await field.fill('E2E Name')
  await field.blur()

  await page.getByRole('link', { name: /unsaved changes/ }).click()
  await expect(page.locator('.diff .add', { hasText: 'display_name = "E2E Name"' })).toBeVisible()
  await expect(page.locator('p.bad')).toHaveCount(0)

  await page.getByRole('button', { name: 'Save config.toml' }).click()
  await expect(page.getByRole('heading', { name: 'Saved' })).toBeVisible()

  const after = readFileSync(configFile, 'utf8').split('\n')
  const gone = before.filter((line) => !after.includes(line))
  const added = after.filter((line) => !before.includes(line))
  expect(gone).toEqual([])
  expect(added).toEqual(['display_name = "E2E Name"'])

  await page.getByRole('button', { name: 'Reload now' }).click()
  await expect(page.getByText('engined runs the saved config').first()).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.locator('.banner')).toHaveText(/running the saved config/)
})
