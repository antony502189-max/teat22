import { expect, test, type Locator, type Page } from '@playwright/test'

async function settle(page: Page) {
  await page.locator('.route-loading').waitFor({ state: 'detached' }).catch(() => undefined)
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(180)
}

async function open(page: Page, route: string, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.goto(route)
  await settle(page)
  if (route.includes('vista=mapa')) {
    await expect(page.locator('.google-map-canvas')).toBeVisible()
    await expect(page.locator('.google-map-canvas')).toHaveAttribute('data-map-instance', 'google-ready', { timeout: 20_000 })
    await expect.poll(() => page.locator('.price-marker-shell, .room-cluster-shell').count(), { timeout: 20_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(500)
  }
}

async function clickFirstInViewport(page: Page, selector: string) {
  const elements = page.locator(selector)
  const index = await elements.evaluateAll((nodes) => nodes.findIndex((node) => {
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight
  }))
  expect(index, `No visible ${selector}`).toBeGreaterThanOrEqual(0)
  await elements.nth(index).click()
}

async function shot(page: Page, name: string, mask: Locator[] = []) {
  // Hide only Google raster tile images at their own DOM layer. Playwright's
  // rectangle mask would sit above markers, polygons and controls as well.
  await page.evaluate(() => {
    if (document.querySelector('#google-raster-visual-mask')) return
    const style = document.createElement('style')
    style.id = 'google-raster-visual-mask'
    style.textContent = '.gm-style img[role="presentation"]{visibility:hidden!important}'
    document.head.append(style)
  })
  await expect(page).toHaveScreenshot(`${name}.png`, {
    animations: 'disabled',
    caret: 'hide',
    mask,
    maskColor: '#c9c9c9',
    maxDiffPixelRatio: 0.04,
  })
}

test('master home responsive matrix', async ({ page }) => {
  test.setTimeout(180_000)
  for (const [width, height] of [[360, 800], [390, 844], [430, 932], [768, 1024], [1024, 900], [1280, 900], [1440, 900]] as const) {
    await open(page, '/#/', width, height)
    await page.locator('.home-hero img').evaluateAll((images) => Promise.all(images.map((node) => {
      const image = node as HTMLImageElement
      if (image.complete) return Promise.resolve()
      return new Promise<void>((resolve) => { image.addEventListener('load', () => resolve(), { once: true }); image.addEventListener('error', () => resolve(), { once: true }) })
    })))
    await shot(page, `master-home-${width}x${height}`, [page.locator('.property-card__media img')])
  }
})

test('master mobile list and map states', async ({ page }) => {
  test.setTimeout(180_000)
  await open(page, '/#/buscar?q=Tenerife', 390, 844)
  await shot(page, 'master-results-list-390x844', [page.locator('.property-card__media img')])

  await open(page, '/#/buscar?q=Tenerife', 430, 932)
  await shot(page, 'master-results-list-430x932', [page.locator('.property-card__media img')])

  await open(page, '/#/buscar?q=Tenerife&vista=mapa', 390, 844)
  await expect(page.locator('.google-map-canvas')).toBeVisible()
  await expect(page.locator('.mobile-map-screen__contextbar')).toBeVisible()
  await expect(page.locator('.mobile-map-screen__contextbar')).toContainText('Filtros')
  await expect(page.locator('.mobile-map-screen__contextbar')).toContainText('Lista')
  const mobileMapGeometry = await page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height }
    }
    const header = box('.mobile-map-screen__header')
    const context = box('.mobile-map-screen__contextbar')
    const canvas = box('.mobile-map-screen__canvas')
    const footer = box('.mobile-map-screen__footer')
    return { header, context, canvas, footer, documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth }
  })
  expect(mobileMapGeometry.header.bottom).toBeCloseTo(mobileMapGeometry.context.top, 0)
  expect(mobileMapGeometry.context.bottom).toBeCloseTo(mobileMapGeometry.canvas.top, 0)
  expect(mobileMapGeometry.canvas.bottom).toBeCloseTo(mobileMapGeometry.footer.top, 0)
  expect(mobileMapGeometry.canvas.height).toBeGreaterThan(560)
  expect(mobileMapGeometry.documentWidth).toBeLessThanOrEqual(mobileMapGeometry.viewportWidth + 1)
  await expect(page.locator('.map-layer-switcher__mobile-toggle')).toBeVisible()
  await expect(page.locator('.map-layer-switcher__options')).toBeHidden()
  await shot(page, 'master-results-map-390x844')

  await open(page, '/#/buscar?q=Adeje&vista=mapa', 390, 844)
  await expect.poll(() => page.locator('.price-marker-shell').evaluateAll((nodes) => nodes.some((node) => {
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight
  }))).toBe(true)
  await clickFirstInViewport(page, '.price-marker-shell')
  await expect(page.locator('.map-selected-card')).toBeVisible()
  const selectedGeometry = await page.locator('.map-selected-card').evaluate((node) => {
    const box = node.getBoundingClientRect()
    const canvas = document.querySelector<HTMLElement>('.mobile-map-screen__canvas')!.getBoundingClientRect()
    return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, canvasBottom: canvas.bottom }
  })
  expect(selectedGeometry.left).toBeGreaterThanOrEqual(8)
  expect(selectedGeometry.right).toBeLessThanOrEqual(382)
  expect(selectedGeometry.bottom).toBeLessThanOrEqual(selectedGeometry.canvasBottom)
  expect(selectedGeometry.width).toBeGreaterThan(360)
  await shot(page, 'master-results-map-selected-390x844', [page.locator('.map-selected-card img')])

  await open(page, '/#/buscar?q=Tenerife&vista=mapa&dibujar=1', 390, 844)
  await expect(page.locator('.google-map-shell')).toHaveAttribute('data-drawing', 'true')
  await expect(page.getByRole('status')).toContainText('Modo dibujo activado')
  const drawingMessage = await page.getByRole('status').boundingBox()
  const drawingCanvas = await page.locator('.mobile-map-screen__canvas').boundingBox()
  expect(drawingMessage).not.toBeNull()
  expect(drawingCanvas).not.toBeNull()
  expect(drawingMessage!.y).toBeLessThan(drawingCanvas!.y + 24)
  await shot(page, 'master-results-map-drawing-390x844')
})

test('master municipality selection and desktop split states', async ({ page }) => {
  test.setTimeout(240_000)
  await open(page, '/#/buscar?q=Tenerife', 390, 844)
  await page.getByRole('button', { name: /Abrir selección de ubicación/i }).first().click()
  await page.getByRole('button', { name: 'Seleccionar municipios en el mapa' }).click()
  const group = page.getByRole('group', { name: 'Municipios de Tenerife' })
  await group.getByRole('button', { name: /^Adeje\b/ }).click()
  await group.getByRole('button', { name: /^Arona\b/ }).click()
  await expect.poll(() => page.locator('.zone-selection .gm-style img[role="presentation"]').count()).toBeGreaterThan(0)
  await shot(page, 'master-zone-selection-390x844')
  await page.keyboard.press('Escape')

  await open(page, '/#/buscar?q=Tenerife&vista=mapa', 1440, 900)
  await expect(page.locator('.map-results-split')).toBeVisible()
  await expect(page.locator('.idealista-results-layout.is-map-view > .filter-sidebar')).toBeHidden()
  const desktopSplit = await page.locator('.map-results-split').evaluate((node) => {
    const list = node.querySelector<HTMLElement>('.map-results-cards')!.getBoundingClientRect()
    const map = node.querySelector<HTMLElement>('.idealista-map-view')!.getBoundingClientRect()
    return { listWidth: list.width, mapWidth: map.width, mapBottom: map.bottom, viewportHeight: window.innerHeight }
  })
  expect(desktopSplit.mapWidth).toBeGreaterThan(desktopSplit.listWidth)
  expect(desktopSplit.mapBottom).toBeLessThanOrEqual(desktopSplit.viewportHeight + 2)
  await page.locator('.map-results-cards .property-card').first().getByRole('link').first().focus()
  await shot(page, 'master-results-split-1440x900', [page.locator('.property-card__media img')])
})
