import crypto from "node:crypto";

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
