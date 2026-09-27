import { test } from '@playwright/test';

import { offerGoogleWorkspace } from './journeys';

test('Google Workspace is the only sign-in option', async ({ page }) => {
  await offerGoogleWorkspace(page);
});
