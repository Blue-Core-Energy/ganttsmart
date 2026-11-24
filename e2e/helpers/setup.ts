import type { Page } from '@playwright/test';

export async function blockFonts(page: Page): Promise<void> {
  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, body: '' }));
}
