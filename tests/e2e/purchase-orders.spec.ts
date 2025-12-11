import { test, expect, type Page } from '@playwright/test'

async function loginIfConfigured(page: Page) {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD

  if (!email || !password) return false

  await page.goto('/login')
  await page.getByRole('textbox', { name: /correo/i }).fill(email)
  await page.getByRole('textbox', { name: /contraseña/i }).fill(password)
  await page.getByRole('button', { name: /iniciar sesión/i }).click()
  await expect(page).toHaveURL(/\/dashboard|\/dashboard\/operator|\/dashboard(\?|$)/)
  return true
}

test.describe('Purchase Orders flows', () => {
  test('Purchases page loads and shows header', async ({ page }) => {
    test.skip(!process.env.E2E_EMAIL || !process.env.E2E_PASSWORD, 'E2E_EMAIL/E2E_PASSWORD not set')
    await loginIfConfigured(page)
    await page.goto('/compras')
    await expect(page.getByRole('heading', { name: 'Órdenes de Compra' })).toBeVisible()
  })

  test('Services page loads and lists service orders table', async ({ page }) => {
    test.skip(!process.env.E2E_EMAIL || !process.env.E2E_PASSWORD, 'E2E_EMAIL/E2E_PASSWORD not set')
    await loginIfConfigured(page)
    await page.goto('/servicios')
    await expect(page.getByText('Órdenes de Servicio')).toBeVisible()
  })

  test('PO details page renders if TEST_PO_ID set', async ({ page }) => {
    const poId = process.env.TEST_PO_ID
    test.skip(!poId, 'TEST_PO_ID not set')
    test.skip(!process.env.E2E_EMAIL || !process.env.E2E_PASSWORD, 'E2E_EMAIL/E2E_PASSWORD not set')
    await loginIfConfigured(page)
    await page.goto(`/compras/${poId}`)
    await expect(page.locator('text=Orden de Compra')).toBeVisible()
  })
})


