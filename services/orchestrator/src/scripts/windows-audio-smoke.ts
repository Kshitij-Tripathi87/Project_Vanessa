import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeWindowsAudio, type WindowsAudioRequest, type WindowsAudioResult } from '../agents/windows-audio.js';

interface SmokeDependencies {
  execute: (request: WindowsAudioRequest) => Promise<WindowsAudioResult>;
  read: (path: string) => Promise<string>;
  save: (path: string, contents: string) => Promise<void>;
}
const defaults: SmokeDependencies = {
  execute: executeWindowsAudio,
  read: path => readFile(path, 'utf8'),
  // Never silently replace the original restore point.
  save: async (path, contents) => { await writeFile(path, contents, { encoding: 'utf8', flag: 'wx' }); },
};

/** Every real audio operation goes through executeWindowsAudio -> sequential executor. */
export async function runWindowsAudioSmoke(args: string[], dependencies = defaults) {
  const [operation, ...rest] = args;
  if (operation === 'get' && rest.length === 1) {
    const result = await dependencies.execute({ operation: 'get' });
    if (result.success) await dependencies.save(resolve(rest[0]), JSON.stringify(result, null, 2));
    return result;
  }
  if (!((operation === 'restore' && rest.length === 1) ||
    (['set-volume', 'set-mute'].includes(operation) && rest.length === 2))) {
    throw new Error('Usage: smoke:windows-audio get <initial.json> | set-volume <0..100> <initial.json> | set-mute <true|false> <initial.json> | restore <initial.json>');
  }
  const stateFile = resolve(rest[rest.length - 1]);
  const initial = JSON.parse((await dependencies.read(stateFile)).replace(/^\uFEFF/, '')) as WindowsAudioResult;
  if (initial?.success !== true || typeof initial.device?.id !== 'string' || !initial.device.id.trim() || !initial.observed ||
    !Number.isFinite(initial.observed.volumePercent) || initial.observed.volumePercent < 0 || initial.observed.volumePercent > 100 ||
    typeof initial.observed.muted !== 'boolean') throw new Error('Invalid saved initial audio state');
  const expectedDeviceId = initial.device.id;
  if (operation === 'set-volume') {
    const percent = Number(rest[0]);
    if (!rest[0].trim() || !Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('Volume must be from 0 to 100');
    return dependencies.execute({ operation: 'setVolume', volumePercent: percent, expectedDeviceId });
  }
  if (operation === 'set-mute') {
    if (!['true', 'false'].includes(rest[0])) throw new Error('Mute must be true or false');
    return dependencies.execute({ operation: 'setMute', muted: rest[0] === 'true', expectedDeviceId });
  }
  const volume = await dependencies.execute({ operation: 'setVolume', volumePercent: initial.observed.volumePercent, expectedDeviceId });
  // Separate calls ensure mute restoration is still attempted after a volume failure.
  const mute = await dependencies.execute({ operation: 'setMute', muted: initial.observed.muted, expectedDeviceId });
  return { success: volume.success && mute.success, volume, mute };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runWindowsAudioSmoke(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.success ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ success: false, error: (error as Error).message }));
    process.exitCode = 1;
  }
}
