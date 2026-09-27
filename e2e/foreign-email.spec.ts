import { test } from '@playwright/test';

import { rejectForeignEmail } from './journeys';

test('disallowed email is rejected', async ({ page }) => {
  await rejectForeignEmail(page);
});
