/** The wire shape of `POST /api/edit` ops, shared by the server editor and the config UI. */

/** Top-level keys, then a table key, or a `[[table]]` entry's index and key; `args` tables nest one deeper. */
export type TomlPath = (string | number)[]

export type EditOp =
  | { op: 'setKey'; path: TomlPath; value: unknown }
  | { op: 'addEntry'; table: string; entry: Record<string, unknown> }
  | { op: 'removeEntry'; table: string; index: number }
  | { op: 'renameId'; table: string; oldId: string; newId: string }
