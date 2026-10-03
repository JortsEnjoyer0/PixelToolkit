// Entity names (folders, characters, animations) map 1:1 to Windows file names
// (docs/architecture.md "Data root and files"). One rule set for the renderer (naming.validateName adds the sibling
// check) and main (imageImport.checkEntityName).

export const MAX_NAME_LENGTH = 64;

const INVALID_CHARS = /[\\/:*?"<>|.]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * User-facing problem with `name`, or null when it is a valid entity name. Rules: not blank, none of \ / : * ? " < > | .
 * or control characters, no leading/trailing spaces (Windows strips them), not a reserved device name, not "base"
 * (the character base image owner), ≤ 64 characters.
 */
export function nameProblem(name: string): string | null {
  if (name.trim().length === 0)
    return 'Name cannot be empty';
  if (INVALID_CHARS.test(name) || CONTROL_CHARS.test(name))
    return 'Name cannot contain \\ / : * ? " < > | or .';
  if (name !== name.trim())
    return 'Name cannot start or end with a space';
  if (RESERVED.test(name))
    return `"${name}" is reserved by Windows`;
  if (name.toLowerCase() === 'base')
    return '"base" is reserved';
  if (name.length > MAX_NAME_LENGTH)
    return `Name must be at most ${MAX_NAME_LENGTH} characters`;
  return null;
}
