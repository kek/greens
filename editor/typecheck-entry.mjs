// Bundle entry: EYG type checking for Greens bots, for Node.
import { type_errors } from "./build/dev/javascript/greens_editor/greens_typecheck.mjs";

// Type errors in a program given as JSON IR, as "path: reason" strings.
export function typeErrors(ir) {
  const result = type_errors(JSON.stringify(ir));
  if (!result.isOk()) throw new Error(result[0]);
  return result[0].toArray();
}
