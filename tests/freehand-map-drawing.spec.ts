import { expect, test, type Page } from '@playwright/test'

const mapReady = async (page: Page) => {
  await expect(page.locator('.google-map-canvas')).toHaveAttribute('data-map-instance', 'google-ready', { timeout: 20_000 })
}

const drawWithPointer = async (page: Page, pointerType: 'mouse' | 'touch') => {
  const overlay = page.getByTestId('map-freehand-overlay')
  await expect(overlay).toBeVisible()
  const box = await overlay.boundingBox()
  expect(box).not.toBeNull()
  const points = [
    [box!.x + box!.width * .25, box!.y + box!.height * .28],
    [box!.x + box!.width * .68, box!.y + box!.height * .25],
    [box!.x + box!.width * .75, box!.y + box!.height * .62],
    [box!.x + box!.width * .35, box!.y + box!.height * .70],
    [box!.x + box!.width * .25, box!.y + box!.height * .28],
  ]
  if (pointerType === 'mouse') {
    await page.mouse.move(...points[0])
    await page.mouse.down()
    for (const point of points.slice(1)) await page.mouse.move(...point, { steps: 12 })
    await page.mouse.up()
    return
  }
  const target = await overlay.elementHandle()
  expect(target).not.toBeNull()
  await target!.dispatchEvent('pointerdown', { pointerId: 11, pointerType: 'touch', isPrimary: true, buttons: 1, clientX: points[0][0], clientY: points[0][1] })
  for (const [clientX, clientY] of points.slice(1)) {
    await target!.dispatchEvent('pointermove', { pointerId: 11, pointerType: 'touch', isPrimary: true, buttons: 1, clientX, clientY })
  }
  await target!.dispatchEvent('pointerup', { pointerId: 11, pointerType: 'touch', isPrimary: true, buttons: 0, clientX: points.at(-1)![0], clientY: points.at(-1)![1] })
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/buscar?q=Tenerife&alquiler=long&vista=mapa')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await mapReady(page)
})

test('mouse freehand drawing applies, filters, and restores from URL', async ({ page }) => {
  await page.getByRole('button', { name: /dibujar zona/i }).click()
  await drawWithPointer(page, 'mouse')
  await expect(page.getByRole('button', { name: /aplicar zona/i })).toBeEnabled()
  await page.getByRole('button', { name: /aplicar zona/i }).click()
  await expect(page).toHaveURL(/poligono=/)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('112233:map-polygon:v1') || '[]').length)).toBeGreaterThan(2)
  await page.reload()
  await mapReady(page)
  await expect(page.getByRole('button', { name: /eliminar zona/i })).toBeVisible()
})

test('touch pointer draws a continuous editable polygon', async ({ page }) => {
  await page.getByRole('button', { name: /dibujar zona/i }).click()
  await drawWithPointer(page, 'touch')
  await expect(page.getByRole('button', { name: /aplicar zona/i })).toBeEnabled()
  await expect(page.getByRole('button', { name: /volver a dibujar/i })).toBeVisible()
  await expect(page.locator('.map-freehand-overlay')).toHaveCount(0)
})
