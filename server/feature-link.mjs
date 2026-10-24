import { z } from 'zod';

// A destination the user opens, never a URL fetched by the companion.
export const featureUrl = z.string().trim().max(2000).refine(value => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}, 'Use a full http:// or https:// feature URL without embedded credentials.');
