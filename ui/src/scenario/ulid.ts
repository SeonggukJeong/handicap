import { ulid } from "ulid";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function newStepId(): string {
  return ulid();
}

export function isStepId(s: string): boolean {
  return ULID_RE.test(s);
}
