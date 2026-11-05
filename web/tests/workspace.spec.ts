import { test, expect } from '@playwright/test';

test('create a case, extract a PDF, inspect its source and correct a fact', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByText('A clearer view')).toBeVisible();
  await page.getByRole('button', { name: 'Create your first case' }).click();
  await page.getByLabel('Case title').fill('Alex Example · discharge review');
  await page.getByRole('button', { name: 'Create case', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Alex Example · discharge review' })).toBeVisible();
  await page.getByRole('button', { name: 'Try a synthetic record' }).click();
  const fact = page.locator('.fact-card').first();
  await expect(fact).toBeVisible({ timeout: 45000 });
  await expect(fact).toContainText('SYNTHETIC RECORD');
  await fact.locator('.source-link').click();
  await expect(page.getByTitle('Original PDF')).toBeVisible();
  await fact.getByRole('button', { name: 'Review & edit' }).click();
  await page.getByLabel('Reviewed text').fill('Synthetic discharge record reviewed.');
  await page.getByRole('button', { name: 'Save review' }).click();
  await expect(fact).toContainText('Synthetic discharge record reviewed.');
  await expect(fact).toContainText('Reviewed');
  await fact.getByRole('button', { name: 'View correction history' }).click();
  await expect(page.getByRole('heading', { name: 'Correction history' })).toBeVisible();
  await expect(page.locator('.history-item')).toContainText('Synthetic discharge record reviewed.');
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  const cases = await (await request.get('/api/cases')).json();
  const id = cases[0].id;
  const details = await (await request.get('/api/cases/' + id)).json();
  const current = details.facts[0];
  const stale = await request.patch('/api/cases/' + id + '/facts/' + current.id, {
    data: { text: 'Stale edit', revision: 0 }
  });
  expect(stale.status()).toBe(409);
  const sample = await (await request.get('/api/sample')).body();
  const duplicates = await Promise.all([1, 2].map(() => request.post('/api/cases/' + id + '/documents', {
    multipart: { file: { name: 'same.pdf', mimeType: 'application/pdf', buffer: sample } }
  })));
  for (const response of duplicates) expect((await response.json()).duplicate).toBe(true);
  const other = await (await request.post('/api/cases', { data: { title: 'Other case' } })).json();
  expect((await request.get('/api/cases/' + other.id + '/documents/' + current.document_id + '/file')).status()).toBe(404);
  expect((await request.patch('/api/cases/' + other.id + '/facts/' + current.id, {
    data: { text: 'Wrong case', revision: current.revision }
  })).status()).toBe(409);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Other case' })).toBeVisible();
  await page.getByRole('button', { name: /Alex Example · discharge review/ }).click();
  await expect(page.locator('.fact-card')).toContainText('Synthetic discharge record reviewed.');
});
