import * as z from 'zod/v4';
import type { DataToolAnnotations, Obj } from './types.js';

/** Small zod helpers so 22 tool schemas stay readable. */
export const str = (max = 200) => z.string().min(1).max(max);
export const strList = (maxItems: number, maxLen = 200) => z.array(str(maxLen)).max(maxItems);
export const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const country2 = () => z.string().regex(/^[A-Za-z]{2}$/, 'ISO 3166-1 alpha-2, e.g. GB');

/** Annotation presets. Every tool sets all four hints explicitly (OpenAI + Anthropic directory requirement). */
export const READ_ONLY: DataToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Saves a private snapshot/baseline in the caller's own Apify storage (no external side effects, nothing deleted). */
export const STATEFUL: DataToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export const COST_NOTE = "Runs an Apify Actor on the caller's own Apify account (billed by Apify pay-per-event, capped per run).";

/** Removes undefined values (Actor inputs should not carry explicit undefined). */
export function compactObj(obj: Obj): Obj {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** Shallow pick. */
export function pick(obj: Obj, keys: string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
export const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const money = (amount: unknown, currency: unknown) => (n(amount) !== undefined ? `${s(currency)} ${n(amount)!.toLocaleString('en-GB')}`.trim() : '');

/** Truncates a string to `max` chars with an ellipsis marker. */
export function clip(v: unknown, max: number): unknown {
  return typeof v === 'string' && v.length > max ? `${v.slice(0, max)}… [truncated]` : v;
}

/** Recursively trims long strings and long arrays so one record cannot flood the model's context. */
export function trimDeep(v: unknown, maxStr = 1200, maxArr = 25, depth = 0): unknown {
  if (typeof v === 'string') return clip(v, maxStr);
  if (Array.isArray(v)) {
    const arr = v.slice(0, maxArr).map((x) => trimDeep(x, maxStr, maxArr, depth + 1));
    return v.length > maxArr ? [...arr, `… ${v.length - maxArr} more`] : arr;
  }
  if (v && typeof v === 'object') {
    if (depth > 6) return '[nested]';
    return Object.fromEntries(Object.entries(v as Obj).map(([k, x]) => [k, trimDeep(x, maxStr, maxArr, depth + 1)]));
  }
  return v;
}
