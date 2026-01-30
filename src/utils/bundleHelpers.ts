import { OutputBundle } from 'rollup';

export function findRemoteEntryFile(filename: string, bundle: OutputBundle) {
  for (const [_, fileData] of Object.entries(bundle)) {
    if (
      filename.replace(/[\[\]]/g, '_').replace(/\.[^/.]+$/, '') === fileData.name ||
      fileData.name === 'remoteEntry'
    ) {
      return fileData.fileName; // We can return early since we only need to find remoteEntry once
    }
  }
}
