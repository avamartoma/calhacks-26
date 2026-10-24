import type { CloudData } from './model.ts';
import seed from './seed.json';

/**
 * Placeholder workspace data. When the workspace backend is ready, this becomes a fetch from
 * its API, which returns the same shape already filtered to what the signed-in user may see.
 */
export const placeholder: CloudData = seed as CloudData;
