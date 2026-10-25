import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeWindowsControl, windowsControlCommand, type WindowsControlRequest, type WindowsControlResult } from '../agents/windows-controls.js';

const usage='Usage: node dist/scripts/windows-controls-smoke.js brightness|bluetooth list|get|set [percent|On|Off] [--name friendly-name | --id discovered-id] [--test | --request]';
export function parseControlArgs(args: string[]): {request:WindowsControlRequest; test:boolean; printRequest:boolean} {
  const [control,operation,...rest]=args;
  if (!['brightness','bluetooth'].includes(control) || !['list','get','set'].includes(operation)) throw new Error(usage);
  const request: Record<string,unknown>={control,operation};
  if (operation==='set') {
    const value=rest.shift();
    if (control==='brightness') {
      if (!value || !/^\d+$/.test(value) || Number(value)>100) throw new Error('Brightness must be an integer 0..100');
      request.brightnessPercent=Number(value);
    } else {
      if (value!=='On' && value!=='Off') throw new Error('Bluetooth requires explicit On or Off');
      request.state=value;
    }
  }
  let test=false, printRequest=false;
  while (rest.length) {
    const flag=rest.shift();
    if (flag==='--test' && !test) test=true;
    else if (flag==='--request' && !printRequest) printRequest=true;
    else if (flag==='--name' || flag==='--id') {
      const value=rest.shift(); const field=flag==='--name'?'targetName':'targetId';
      if (!value?.trim() || request.targetName || request.targetId || operation==='list') throw new Error('Supply exactly one nonempty discovered selection for get/set');
      request[field]=value;
    } else throw new Error(usage);
  }
  if (test && (operation!=='set' || printRequest)) throw new Error('--test requires set and cannot be combined with --request');
  return {request:request as WindowsControlRequest,test,printRequest};
}

/** Manual opt-in only. Normal set persists; --test captures before mutation and restores exact ID. */
export async function runControlSmoke(args:string[], execute=executeWindowsControl) {
  const {request,test,printRequest}=parseControlArgs(args);
  if (printRequest) return {timeoutMs:30000,steps:[{id:'windows-control',command:windowsControlCommand(request)}]};
  if (!test) return execute(request);
  const capture=await execute({control:request.control,operation:'get',...(request.targetId?{targetId:request.targetId}:{}),...(request.targetName?{targetName:request.targetName}:{})});
  if (!capture.success || !capture.verification.passed || !capture.target?.id || !capture.observed || !('id' in capture.observed)) throw new Error('Initial capture failed; no mutation/restoration attempted: '+(capture.error?.message ?? 'Incomplete snapshot'));
  const before=capture.observed, id=capture.target.id;
  const restoreRequest:WindowsControlRequest=request.control==='brightness'
    ? {control:'brightness',operation:'set',targetId:id,brightnessPercent:before.brightnessPercent!}
    : {control:'bluetooth',operation:'set',targetId:id,state:before.state as 'On'|'Off'};
  if (request.control==='brightness' ? !Number.isInteger(before.brightnessPercent) || before.brightnessPercent!<0 || before.brightnessPercent!>100 : !['On','Off'].includes(before.state ?? '')) throw new Error('Captured state is not safely restorable; no mutation attempted');
  let change:WindowsControlResult|undefined, restoration:WindowsControlResult|undefined, changeError:string|undefined;
  try { change=await execute({...request,targetId:id,targetName:undefined}); }
  catch(error) { changeError=(error as Error).message; }
  finally { restoration=await execute(restoreRequest); }
  return {success:!!change?.success && change.verification.passed && !!restoration?.success && restoration.verification.passed,capture,change,changeError,restoration};
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2), result=await runControlSmoke(args);
    console.log(JSON.stringify(result,null,2));
    process.exitCode=args.includes('--request') || ('success' in result && result.success)?0:1;
  } catch(error) { console.error(JSON.stringify({success:false,error:(error as Error).message}));process.exitCode=1; }
}
