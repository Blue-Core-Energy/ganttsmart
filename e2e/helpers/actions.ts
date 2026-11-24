import type { Page } from '@playwright/test';

export async function dismissToasts(page: Page): Promise<void> {
  const closeButtons = page.locator('.fixed.bottom-6 button:has-text("×")');
  while ((await closeButtons.count()) > 0) {
    await closeButtons.first().click();
  }
}
