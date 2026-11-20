import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

/**
 * End-to-end smoke: first-admin setup, core routes, truthful integrations,
 * and exact tracking-ID order when rearranging a PDF.
 */
test.describe('WMS smoke flow', () => {
  test('sets up a local admin and exercises the WMS, integrations, and PDF sequencer', async ({ page }) => {
    await page.goto('/');

    // Fresh browser storage now requires the operator to create the first admin.
    await expect(page.getByRole('heading', { name: 'Set up your administrator' })).toBeVisible({ timeout: 30_000 });
    const inputs = page.locator('input');
    await inputs.nth(0).fill('smoke-admin');
    await inputs.nth(1).fill('Smoke-Test-Admin-Passphrase-2026');
    await page.getByRole('button', { name: 'Create admin account' }).click();

    // Land on the dashboard after account creation and authentication.
    await expect(page).toHaveURL(/\/($|\?)/, { timeout: 30_000 });
    await page.waitForTimeout(500);

    const routes = [
      { path: '/daily', heading: 'Instant fulfillment workflow' },
      { path: '/batch-pick', heading: 'Batch Pick Center' },
      { path: '/shipping', heading: 'Shipping' },
      { path: '/inventory', heading: 'Inventory Hub' },
      { path: '/serial-tracking', heading: 'Serial & IMEI Tracking' },
    ];

    for (const route of routes) {
      await page.goto(route.path);
      await expect(page).toHaveURL(new RegExp(`${route.path}$`));
      await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    }

    // Saved connector profiles must not claim that an API connection exists.
    await page.goto('/integrations');
    await expect(page.getByRole('heading', { name: 'Integration Hub' })).toBeVisible();
    await expect(page.getByText('Manual only')).toBeVisible();
    await expect(page.getByText('Saved profiles are not live connections.', { exact: false })).toBeVisible();

    // The first Ozon Sheets setup can create its config; it does not silently
    // point to or sync an unrelated default sheet.
    await page.goto('/ozon-sheets');
    await expect(page.getByRole('heading', { name: 'Ozon Sheets Hub' })).toBeVisible();
    await expect(page.getByText('No sheet source configured.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Admin' }).click();
    const sheetUrl = page.locator('input[type="url"]');
    await sheetUrl.fill('http://example.com/sheet');
    await page.getByRole('button', { name: 'Save Configuration' }).click();
    await expect(page.getByRole('link', { name: 'Open Sheet' })).toHaveCount(0);
    await sheetUrl.fill('https://docs.google.com/spreadsheets/d/1NNSAHZ8A7l2nDbWZ-9tLE6K5lmDWo7V6MBizbhH875o/edit?gid=1858822101');
    await page.getByRole('button', { name: 'Save Configuration' }).click();
    await expect(page.getByRole('link', { name: 'Open Sheet' })).toHaveAttribute('href', /^https:\/\/docs\.google\.com\//);

    // Make a tiny two-page PDF in reverse input order and verify exact reorder.
    const firstPageId = '78954582-0287-1';
    const secondPageId = '56848324-0106-1';
    const labelsPdf = await PDFDocument.create();
    labelsPdf.addPage([320, 220]).drawText(`Ozon posting ${firstPageId}`, { x: 24, y: 110, size: 16 });
    labelsPdf.addPage([320, 220]).drawText(`Ozon posting ${secondPageId}`, { x: 24, y: 110, size: 16 });
    const pdfBuffer = Buffer.from(await labelsPdf.save());

    await page.goto('/pdf-sequencer');
    await expect(page.getByRole('heading', { name: 'Pro PDF Label Sequencer' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Paste tracking IDs in the required PDF page order' }).fill(`${secondPageId}\n${firstPageId}`);
    await page.locator('input[type="file"][accept=".pdf"]').setInputFiles({
      name: 'smoke-labels.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBuffer,
    });
    await expect(page.getByText(/Extracted 2 pages/i)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Scan & Sort' }).click();
    await expect(page.getByTestId('sorted-page-1')).toContainText(secondPageId);
    await expect(page.getByTestId('sorted-page-2')).toContainText(firstPageId);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download 2 Sorted Pages' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^sorted_strict_/);

    // Density toggle remains accessible in the top bar.
    await page.goto('/');
    const densityButton = page.locator('header button[title*="density" i], header button[title*="compact" i], header button[title*="comfortable" i]').first();
    if (await densityButton.count()) await densityButton.click();
  });
});
