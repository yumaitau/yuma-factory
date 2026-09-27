import { test } from '@playwright/test';

import { cleanupUser, uniqueEmail } from './support';
import { runPortableJourneys } from './journeys';

test('portable user journeys', async ({ page, request }) => {
  test.setTimeout(90_000);
  const email = uniqueEmail('chromium');
  try {
    await runPortableJourneys(page, email);
  } finally {
    await cleanupUser(email, request);
  }
});
