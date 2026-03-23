import { createHash } from "node:crypto";

export function hashCodeContext(code: string, context: string): string {
  return createHash("sha1")
    .update(code)
    .update("\n---\n")
    .update(context)
    .digest("hex");
}
