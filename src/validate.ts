export const MAX_INPUT_LENGTH = 20_000;

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_INPUT_LENGTH) {
    throw new Error(`${field} is too long`);
  }
  return value.trim();
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
