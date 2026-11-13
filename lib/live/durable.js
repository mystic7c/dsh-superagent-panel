import { open, writeFile } from 'node:fs/promises'

/**
 * Write a temp file and fsync it before the caller renames it into place. A bare writeFile + rename survives a
 * process crash, but on a power loss the directory entry can point at a file whose data blocks were never flushed,
 * leaving a zero-length JSON document. Every temp+rename store goes through this helper.
 */
export async function writeFileDurable(file, data, options) {
  await writeFile(file, data, options)
  const handle = await open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}
