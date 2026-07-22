import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { isExpectedHeadlessVectorFallback } from './helpers/google-maps-console'

const matrix = [
  { width: 375, height: 812, mode: 'mobile' },
  { width: 390, height: 844, mode: 'mobile' },
  { width: 768, height: 1024, mode: 'tablet' },
  { width: 1024, height: 768, mode: 'desktop' },
  { width: 1440, height: 900, mode: 'desktop' },
] as const

async function openMap(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.goto('/#/buscar?q=Tenerife&vista=mapa')
  await page.locator('.route-loading').waitFor({ state: 'detached' }).catch(() => undefined)
  await page.evaluate(async () => { await document.fonts.ready })
  await expect(page.locator('.google-map-canvas')).toHaveAttribute('data-map-instance', 'google-ready', { timeout: 20_000 })
  await expect.poll(() => page.locator('.price-marker-shell, .room-cluster-shell').count(), { timeout: 20_000 }).toBeGreaterThan(0)
}

test('results map keeps Idealista-style geometry across the responsive matrix', async ({ page }) => {
  test.setTimeout(240_000)
  const unexpectedConsoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (isExpectedHeadlessVectorFallback(message.text())) return
    unexpectedConsoleErrors.push(message.text())
  })

  const output = path.join(process.cwd(), 'output', 'playwright', 'idealista-parity')
  await mkdir(output, { recursive: true })

  for (const viewport of matrix) {
    await openMap(page, viewport.width, viewport.height)
    const geometry = await page.evaluate(() => {
      const documentElement = document.documentElement
      const map = document.querySelector<HTMLElement>('.google-map-canvas')!.getBoundingClientRect()
      return {
        documentWidth: documentElement.scrollWidth,
        viewportWidth: documentElement.clientWidth,
        mapWidth: map.width,
        mapHeight: map.height,
        mapBottom: map.bottom,
        viewportHeight: window.innerHeight,
      }
    })

    expect(geometry.documentWidth, `${viewport.width}px horizontal overflow`).toBeLessThanOrEqual(geometry.viewportWidth + 1)
    expect(geometry.mapWidth).toBeGreaterThan(viewport.mode === 'mobile' ? viewport.width - 2 : 360)
    expect(geometry.mapHeight).toBeGreaterThan(viewport.mode === 'mobile' ? 520 : 360)

    if (viewport.mode === 'mobile') {
      await expect(page.locator('.mobile-map-screen__contextbar')).toBeVisible()
      await expect(page.locator('.mobile-map-screen__footer')).toBeVisible()
      await expect(page.locator('.map-layer-switcher__mobile-toggle')).toBeVisible()
      await expect(page.locator('.map-toolbar__draw')).toBeVisible()
    } else {
      await expect(page.locator('.map-results-split')).toBeVisible()
      await expect(page.locator('.idealista-results-layout.is-map-view > .filter-sidebar')).toBeHidden()
      expect(geometry.mapBottom).toBeLessThanOrEqual(geometry.viewportHeight + 12)
    }

    await page.getByRole('button', { name: 'Dibujar zona' }).focus()
    await expect(page.getByRole('button', { name: 'Dibujar zona' })).toBeFocused()
    await page.screenshot({
      path: path.join(output, `final-map-${viewport.width}x${viewport.height}.png`),
      animations: 'disabled',
      caret: 'hide',
    })
  }

  expect(unexpectedConsoleErrors).toEqual([])
})
