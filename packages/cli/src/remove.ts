import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { removeDeskmateEntry } from "./config-file.js";
import { CONFIG_FILE, editConfig } from "./add.js";
import { isValidId } from "./lib/ids.js";

/**
 * `deskmate remove <id...>`: delete `./roles/<id>` and drop its `deskmates.<id>`
 * config entry (printing guidance if the config can't be edited).
 */
export function remove(ids: string[], cwd: string = process.cwd()): void {
  for (const id of ids) {
    // Guard BEFORE any fs op: `id` is joined onto `roles/` and then `rmSync`'d, so a
    // value like "../foo" would delete a directory OUTSIDE roles/. Reject it up front.
    if (!isValidId(id)) {
      console.error(
        `✗ ${id}: invalid id — must be snake_case (a lowercase letter, then letters/digits/underscores).`,
      );
      process.exitCode = 1;
      continue;
    }
    const dest = join(cwd, "roles", id);
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
      console.log(`✓ removed roles/${id}`);
    } else {
      console.log(`• ${id}: roles/${id} not present, skipping`);
    }
    editConfig(
      cwd,
      id,
      (s) => removeDeskmateEntry(s, id),
      `Remove the \`${id}\` key from the deskmates object in ${CONFIG_FILE}.`,
      `${id}: not in ${CONFIG_FILE}`,
    );
  }
}
