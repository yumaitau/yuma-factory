import { DEFAULT_LABEL_PREFIX, factoryLabels } from '@/shared/ticket-risk';

// Build-time settings: NEXT_PUBLIC_* values are inlined into server and client bundles.
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || 'Factory';

export const LABEL_PREFIX = process.env.NEXT_PUBLIC_LABEL_PREFIX?.trim().toLowerCase() || DEFAULT_LABEL_PREFIX;
if (!/^[a-z0-9][a-z0-9-]*$/.test(LABEL_PREFIX)) throw new Error('NEXT_PUBLIC_LABEL_PREFIX must be lowercase letters, digits or hyphens.');

export const LABELS = factoryLabels(LABEL_PREFIX);
