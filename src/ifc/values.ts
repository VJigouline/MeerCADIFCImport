// Helpers for reading attribute values of IFC entities.

import { StepEnum, StepRef, StepTyped, type StepEntity, type StepFile, type StepValue } from '../step/step.js';

/** Unwraps defined-type values: IFCLENGTHMEASURE(2.5) is 2.5. */
export function unwrap(value: StepValue | undefined): StepValue | undefined {
  let v = value;
  while (v instanceof StepTyped) v = v.value;
  return v;
}

export function num(value: StepValue | undefined, fallback = NaN): number {
  const v = unwrap(value);
  return typeof v === 'number' ? v : fallback;
}

export function str(value: StepValue | undefined): string | null {
  const v = unwrap(value);
  return typeof v === 'string' ? v : null;
}

export function bool(value: StepValue | undefined, fallback = false): boolean {
  const v = unwrap(value);
  if (v instanceof StepEnum) {
    if (v.value === 'T') return true;
    if (v.value === 'F') return false;
  }
  return fallback;
}

export function enumValue(value: StepValue | undefined): string | null {
  const v = unwrap(value);
  return v instanceof StepEnum ? v.value : null;
}

export function list(value: StepValue | undefined): StepValue[] {
  const v = unwrap(value);
  return Array.isArray(v) ? v : [];
}

export function refId(value: StepValue | undefined): number | null {
  return value instanceof StepRef ? value.id : null;
}

/** The entity an attribute references, if any. */
export function deref(file: StepFile, value: StepValue | undefined): StepEntity | null {
  return value instanceof StepRef ? file.get(value.id) ?? null : null;
}

/** Entities referenced by a list attribute, skipping anything else. */
export function derefList(file: StepFile, value: StepValue | undefined): StepEntity[] {
  const out: StepEntity[] = [];
  for (const v of list(value)) {
    const e = deref(file, v);
    if (e) out.push(e);
  }
  return out;
}

/** A plain JavaScript value for a property: numbers, strings, booleans, or arrays of them. */
export function plainValue(value: StepValue | undefined): unknown {
  const v = unwrap(value);
  if (v instanceof StepEnum) return v.value === 'T' ? true : v.value === 'F' ? false : v.value === 'U' ? null : v.value;
  if (v instanceof StepRef) return `#${v.id}`;
  if (Array.isArray(v)) return v.map(plainValue);
  if (typeof v === 'symbol') return null;
  return v ?? null;
}
