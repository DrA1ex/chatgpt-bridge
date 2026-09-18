/**
 * Persisted snapshots fsync their file before the atomic rename. A directory
 * fsync adds the final rename durability barrier on POSIX, but some Windows
 * filesystems reject fsync with EPERM/EINVAL/ENOTSUP. Treat those platform
 * compatibility errors as a best-effort barrier so a normal Bridge startup
 * cannot crash after a successful snapshot write.
 */
export function isFsyncCompatibilityError(error, platform = process.platform) {
  return platform === 'win32' && ['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code);
}

export async function syncHandleBestEffort(handle, platform = process.platform) {
  try {
    await handle.sync();
  } catch (error) {
    if (!isFsyncCompatibilityError(error, platform)) throw error;
    return false;
  }
  return true;
}

export async function syncDirectoryBestEffort(fs, directoryPath, platform = process.platform) {
  let directory;
  try {
    directory = await fs.open(directoryPath, 'r');
    return await syncHandleBestEffort(directory, platform);
  } catch (error) {
    if (!isFsyncCompatibilityError(error, platform)) throw error;
    return false;
  } finally {
    if (directory) await directory.close();
  }
}
