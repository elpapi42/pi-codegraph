export const MAX_INPUT_LENGTH = 20_000;
export const MAX_PATH_LENGTH = 4_096;

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_INPUT_LENGTH) {
    throw new Error(`${field} is too long`);
  }
  return value.trim();
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  if (value.length > MAX_INPUT_LENGTH) {
    throw new Error(`${field} is too long`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function optionalPath(value: unknown, field = "path"): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  if (value.length > MAX_PATH_LENGTH) {
    throw new Error(`${field} is too long`);
  }
  const trimmed = value.replace(/^@/, "").trim().replace(/^\.\//, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null) return fallback;
  return value === true;
}
