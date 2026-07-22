import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

const STATES = ['035', '037', '042', '043', '045', '057', '060', '063', '066', '090'] as const
type State = typeof STATES[number]
type Box = { x: number; y: number; width: number; height: number } | null

const root = path.join(process.cwd(), 'artifacts', 'final-parity')
const actualDir = path.join(root, 'actual')
const targetDir = path.join(root, 'target')
const geometryDir = path.join(root, 'geometry')

const selectors = {
  header: '.mobile-map-screen__header',
  contextBar: '.mobile-map-screen__contextbar',
  mapCanvas: '.results-map',
  searchThisArea: '.map-toolbar__search.is-visible',
  layerControl: '.map-layer-switcher__mobile-toggle',
  locationControl: '.map-toolbar__locate',
  drawControl: '.map-toolbar__draw',
  listMapSwitcher: '.mobile-map-screen__footer',
  selectedListingSheet: '.selected-listing-sheet',
  locationDialog: '.location-selector-dialog',
  resultsList: '.idealista-results',
} as const

const expectedMapGeometry: Record<string, Box> = {
  header: { x: 0, y: 0, width: 390, height: 70 },
  contextBar: { x: 0, y: 70, width: 390, height: 55 },
  mapCanvas: { x: 0, y: 125, width: 390, height: 636 },
  layerControl: { x: 317, y: 615, width: 54, height: 54 },
  locationControl: { x: 317, y: 688, width: 54, height: 54 },
  drawControl: { x: 38, y: 688, width: 279, height: 54 },
  listMapSwitcher: { x: 0, y: 761, width: 390, height: 83 },
}

const expectedSelectedGeometry: Record<string, Box> = {
  ...expectedMapGeometry,
  layerControl: null,
  locationControl: null,
  drawControl: null,
  selectedListingSheet: { x: 9, y: 364, width: 372, height: 394 },
}

async function box(locator: Locator): Promise<Box> {
  if (!await locator.count() || !await locator.first().isVisible()) return null
  const value = await locator.first().boundingBox()
  if (!value) return null
  return Object.fromEntries(Object.entries(value).map(([key, number]) => [key, Math.round(number * 100) / 100])) as NonNullable<Box>
}

function delta(actual: Box, target: Box) {
  if (!actual || !target) return actual === target ? null : { missingOrUnexpected: true }
  return {
    x: Math.round((actual.x - target.x) * 100) / 100,
    y: Math.round((actual.y - target.y) * 100) / 100,
    width: Math.round((actual.width - target.width) * 100) / 100,
    height: Math.round((actual.height - target.height) * 100) / 100,
  }
}

async function settleMap(page: Page) {
  await expect(page.locator('.google-map-canvas')).toHaveAttribute('data-map-instance', 'google-ready', { timeout: 25_000 })
  await expect.poll(() => page.locator('.map-price-marker-shell, .map-cluster-marker-shell').count(), { timeout: 25_000 }).toBeGreaterThan(0)
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(350)
}

async function capture(page: Page, state: State, targetGeometry: Record<string, Box> = {}) {
  await page.evaluate(async () => { await document.fonts.ready })
  const actual = Object.fromEntries(await Promise.all(Object.entries(selectors).map(async ([name, selector]) => [name, await box(page.locator(selector))])))
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
  }))
  const deltas = Object.fromEntries(Object.entries(targetGeometry).map(([name, target]) => [name, delta(actual[name] as Box, target)]))
  await page.screenshot({ path: path.join(actualDir, `${state}-actual.png`), animations: 'disabled', caret: 'hide' })
  await writeFile(path.join(geometryDir, `${state}-geometry.json`), JSON.stringify({
    state,
    viewport,
    targetCoordinateSystem: {
      sourceViewport: { width: 390, height: 844 },
      sourceSystemChrome: { top: 31, bottom: 52 },
      normalization: 'Target app geometry is measured after subtracting the 31 px captured Android status bar. The system navigation bar is outside the app frame.',
    },
    target: targetGeometry,
    actual,
    deltas,
    thresholds: { positionPx: 4, sizePx: 6 },
  }, null, 2), 'utf8')
  expect(viewport.documentWidth, `${state} horizontal overflow`).toBeLessThanOrEqual(viewport.width + 1)

  for (const [name, target] of Object.entries(targetGeometry)) {
    const current = actual[name] as Box
    if (target === null) {
      expect(current, `${state} ${name} should be absent`).toBeNull()
      continue
    }
    expect(current, `${state} ${name} should be visible`).not.toBeNull()
    expect(Math.abs(current!.x - target.x), `${state} ${name} x`).toBeLessThanOrEqual(4)
    expect(Math.abs(current!.y - target.y), `${state} ${name} y`).toBeLessThanOrEqual(4)
    expect(Math.abs(current!.width - target.width), `${state} ${name} width`).toBeLessThanOrEqual(6)
    expect(Math.abs(current!.height - target.height), `${state} ${name} height`).toBeLessThanOrEqual(6)
  }
}

async function clickFirstVisible(page: Page, selector: string) {
  const items = page.locator(selector)
  const index = await items.evaluateAll((nodes) => nodes.findIndex((node) => {
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
  }))
  expect(index, `No visible ${selector}`).toBeGreaterThanOrEqual(0)
  await items.nth(index).click()
}

test('capture and gate the mandatory Idealista target states', async ({ page }) => {
  test.setTimeout(480_000)
  await Promise.all([mkdir(actualDir, { recursive: true }), mkdir(targetDir, { recursive: true }), mkdir(geometryDir, { recursive: true })])
  await Promise.all(STATES.map((state) => copyFile(path.join(process.cwd(), 'artifacts', 'v4-exact-design', 'target', `${state}.png`), path.join(targetDir, `${state}-target.png`))))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/')
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('112233:language:v1', 'ru')
  })

  await page.goto('/#/buscar?q=Tenerife&alquiler=long&vista=mapa')
  await page.locator('.location-selector-trigger').first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await capture(page, '035')
  await page.keyboard.press('Escape')

  await page.goto('/#/buscar?q=Tenerife&alquiler=long&vista=mapa&dibujar=1')
  await settleMap(page)
  await expect(page.locator('.results-map.is-drawing')).toBeVisible()
  await capture(page, '037')
  for (let point = 0; point < 3; point += 1) await page.locator('.map-toolbar__add-point').click()
  await capture(page, '042')
  await page.locator('.map-toolbar__finish').click()
  await expect(page.locator('.results-map.has-polygon')).toBeVisible()
  await capture(page, '043')
  const selectedZonePolygon = '28.02,-16.80;28.22,-16.80;28.22,-16.56;28.02,-16.56'
  await page.goto(`/#/buscar?q=Tenerife&alquiler=long&poligono=${encodeURIComponent(selectedZonePolygon)}`)
  await expect(page.locator('.results-list')).toBeVisible()
  await capture(page, '045')

  await page.goto('/#/buscar?q=Tenerife&alquiler=long')
  await expect(page.locator('.results-list')).toBeVisible()
  await capture(page, '057')

  const polygon = '28.28,-16.72;28.22,-16.60;28.08,-16.58;27.98,-16.68;28.00,-16.82;28.10,-16.87;28.23,-16.84'
  await page.goto(`/#/buscar?q=Tenerife&alquiler=long&vista=mapa&poligono=${encodeURIComponent(polygon)}`)
  await page.reload()
  await settleMap(page)
  await capture(page, '060', expectedMapGeometry)
  await clickFirstVisible(page, '.map-cluster-marker-shell')
  await page.waitForTimeout(450)
  await expect(page.getByRole('button', { name: /buscar en esta zona/i })).toHaveCount(0)
  await capture(page, '063', expectedMapGeometry)
  await clickFirstVisible(page, '.map-price-marker-shell')
  await expect(page.locator('.selected-listing-sheet')).toBeVisible()
  await capture(page, '066', expectedSelectedGeometry)
  await page.locator('.selected-listing-sheet__favorite').click()
  await page.locator('[data-sonner-toast]').first().waitFor({ state: 'detached', timeout: 8_000 }).catch(() => undefined)
  await capture(page, '090', expectedSelectedGeometry)
})
