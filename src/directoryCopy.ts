import { constants, cpSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

function assertReadableDirectoryTree(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    assertReadableDirectoryTree(join(path, entry.name));
  }
}

export function copyDirectory(source: string, destination: string): void {
  // On macOS, fs.cpSync can terminate the process when it encounters an unreadable nested
  // directory. Enumerating first converts that case into a regular filesystem error.
  assertReadableDirectoryTree(source);
  cpSync(source, destination, { recursive: true, mode: constants.COPYFILE_FICLONE });
}
