import { open, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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

/**
 * fsync one directory so a rename into it is not lost by a crash that happens after the rename returned.
 * Some platforms refuse to open/fsync a directory; there the rename is already durable, so those codes are ignored.
 */
export async function syncDirectory(dir) {
  let handle
  try {
    handle = await open(dir, 'r')
  } catch (error) {
    if (['EINVAL', 'EPERM', 'EISDIR', 'EBADF', 'ENOTSUP', 'EACCES'].includes(error?.code)) return
    throw error
  }
  try {
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR', 'EBADF', 'ENOTSUP', 'EACCES'].includes(error?.code)) throw error
  } finally {
    await handle.close()
  }
}

/**
 * Rename a durable temp file over its target and fsync the target's directory. The fsync is what makes the rename
 * itself survive a power loss: without it the old directory block can come back and the temp write is lost.
 */
export async function renameDurable(from, target) {
  await rename(from, target)
  await syncDirectory(dirname(target))
}
