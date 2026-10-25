import { executePowerShellSteps } from './powershell-executor.js';
import { windowsControlsBackend } from './windows-controls-backend.js';
import { windowsControlsController } from './windows-controls-controller.js';

type Selection = { targetId?: string; targetName?: string; waitMs?: number };
export type WindowsControlRequest = Selection & (
  { control: 'brightness' | 'bluetooth'; operation: 'list' | 'get' } |
  { control: 'brightness'; operation: 'set'; brightnessPercent: number } |
  { control: 'bluetooth'; operation: 'set'; state: 'On' | 'Off' }
);
export interface WindowsControlDevice {
  id: string; name: string; state?: string; brightnessPercent?: number; levels?: number[]; supported?: boolean;
}
export interface WindowsControlResult {
  success: boolean;
  control?: string;
  operation?: string;
  requested: WindowsControlRequest;
  target: { id: string; name?: string } | null;
  observed: WindowsControlDevice | { devices: WindowsControlDevice[] } | null;
  verification: { passed: boolean; kind: string; waitedMs: number };
  error: { code: string; message: string; hresult?: string } | null;
}

/** Trusted fixed definitions embedded in built JS, not imported PowerShell files. */
export const windowsControlDefinitions = windowsControlsBackend + '\n' + windowsControlsController;
export function windowsControlCommand(request: WindowsControlRequest): string {
  const json=JSON.stringify(request).replace(/'/g,"''");
  return `${windowsControlDefinitions}\n$controlResult = Invoke-WindowsControl ('${json}' | ConvertFrom-Json)\n$controlResult | ConvertTo-Json -Depth 12 -Compress\nif (-not $controlResult.success) { throw ($controlResult.error.code + ': ' + $controlResult.error.message) }`;
}

/** Internal primitive: apply existing permissions/approvals before calling. */
export async function executeWindowsControl(request: WindowsControlRequest, executor=executePowerShellSteps): Promise<WindowsControlResult> {
  try {
    const batch=await executor({timeoutMs:30000,steps:[{id:'windows-control',command:windowsControlCommand(request)}]});
    const step=batch.steps[0];
    if (!step || step.outputTruncated) throw new Error('Missing or truncated control result');
    const result=JSON.parse(step.stdout.trim()) as WindowsControlResult;
    if (typeof result?.success !== 'boolean' || typeof result.verification?.passed !== 'boolean') throw new Error('Invalid control result protocol');
    if (result.success) {
      if (!batch.success || step.status !== 'completed' || !result.verification.passed) throw new Error(batch.error || step.stderr || 'Unverified/interrupted control result');
      if (request.operation === 'list') {
        if (!result.observed || !('devices' in result.observed) || !Array.isArray(result.observed.devices)) throw new Error('Missing discovery candidates');
      } else {
        if (!result.target?.id || !result.observed || !('id' in result.observed) || result.observed.id !== result.target.id) throw new Error('Missing/mismatched target identity');
        const observed=result.observed;
        if (request.control === 'brightness' && (!Number.isInteger(observed.brightnessPercent) || observed.brightnessPercent! < 0 || observed.brightnessPercent! > 100)) throw new Error('Invalid brightness observation');
        if (request.control === 'bluetooth' && !['On','Off','Disabled','Unknown'].includes(observed.state ?? '')) throw new Error('Invalid radio state observation');
        if (request.operation === 'set' && (request.control === 'brightness' ? observed.brightnessPercent !== request.brightnessPercent : observed.state !== request.state)) throw new Error('Requested state does not match observation');
      }
    }
    return result;
  } catch (error) {
    return {success:false,requested:request,target:null,observed:null,verification:{passed:false,kind:'executor_failure',waitedMs:0},error:{code:'executor_failure',message:(error as Error).message}};
  }
}
