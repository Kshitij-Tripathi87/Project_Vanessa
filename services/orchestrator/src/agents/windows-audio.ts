import { fileURLToPath } from 'node:url';
import { executePowerShellSteps } from './powershell-executor.js';

export type WindowsAudioRequest = (
  { operation: 'get' } |
  { operation: 'setVolume'; volumePercent: number } |
  { operation: 'setMute'; muted: boolean }
) & { expectedDeviceId?: string };
export interface WindowsAudioResult {
  success: boolean;
  operation?: string;
  requested: { volumePercent?: number; muted?: boolean } | null;
  observed: { volumePercent: number; muted: boolean } | null;
  device: { id: string; flow: 'render'; role: 'multimedia'; currentDefaultId: string | null } | null;
  error: { code: string; message: string; hresult?: string } | null;
}

export const windowsAudioHelperPath = fileURLToPath(new URL('./windows-audio/CoreAudio.cs', import.meta.url));
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** An absolute helper path and JSON data; caller still applies existing permissions. */
export function windowsAudioCommand(request: WindowsAudioRequest): string {
  return `if (-not ('Vanessa.WindowsAudio.AudioControl' -as [type])) {
  Add-Type -Path ${literal(windowsAudioHelperPath)} -ReferencedAssemblies 'System.dll','System.Core.dll','System.Web.Extensions.dll' -ErrorAction Stop
}
$audioResult = [Vanessa.WindowsAudio.AudioControl]::Execute(${literal(JSON.stringify(request))})
$audioResult | ConvertTo-Json -Depth 8 -Compress
if (-not $audioResult.success) { throw ('Windows audio operation failed: ' + $audioResult.error.message) }`;
}

export async function executeWindowsAudio(
  request: WindowsAudioRequest,
  executor: typeof executePowerShellSteps = executePowerShellSteps,
): Promise<WindowsAudioResult> {
  let batch;
  try {
    batch = await executor({ steps: [{ id: 'windows-audio', command: windowsAudioCommand(request) }], timeoutMs: 30000 });
  } catch (error) {
    return { success: false, requested: null, observed: null, device: null,
      error: { code: 'executor_failure', message: (error as Error).message } };
  }
  try {
    const result = JSON.parse(batch.steps[0].stdout.trim()) as WindowsAudioResult;
    if (!result || typeof result.success !== 'boolean' || (result.success && (
      !result.device?.id || !result.observed || typeof result.observed.muted !== 'boolean' ||
      !Number.isFinite(result.observed.volumePercent) || result.observed.volumePercent < 0 || result.observed.volumePercent > 100
    ))) throw new Error('Invalid audio result');
    if (result.success && !batch.success) return { ...result, success: false, error: { code: 'executor_failure', message: batch.error ?? batch.steps[0].stderr } };
    return result;
  } catch {
    return { success: false, requested: null, observed: null, device: null,
      error: { code: 'executor_failure', message: batch.error ?? (batch.steps[0].stderr || 'Missing audio JSON result') } };
  }
}
