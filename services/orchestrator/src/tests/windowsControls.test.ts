import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { executePowerShellSteps } from '../agents/powershell-executor.js';
import { windowsControlsBackend } from '../agents/windows-controls-backend.js';
import { windowsControlsController } from '../agents/windows-controls-controller.js';
import { executeWindowsControl, windowsControlCommand, type WindowsControlRequest, type WindowsControlResult } from '../agents/windows-controls.js';
import { parseControlArgs, runControlSmoke } from '../scripts/windows-controls-smoke.js';
import { WindowsAgent } from '../agents/windows.agent.js';
import { PermissionGuard } from '../core/permissionGuard.js';
import type { Task } from '@vanessa/shared';

const win={skip:process.platform!=='win32'};
const literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
async function run(script:string) {
  const batch=await executePowerShellSteps({timeoutMs:60000,steps:[{id:'test',command:script}]});
  assert.equal(batch.success,true,JSON.stringify(batch));
  return JSON.parse(batch.steps[0].stdout.trim());
}
function snapshot(request:WindowsControlRequest, value=90):WindowsControlResult {
  return {success:true,control:request.control,operation:request.operation,requested:request,target:{id:'chosen',name:'Display'},observed:{id:'chosen',name:'Display',brightnessPercent:value,state:'On'},verification:{passed:true,kind:'test',waitedMs:0},error:null};
}
test('command uses inline fixed helpers and escaped JSON, without script imports or policy changes',()=>{
  const command=windowsControlCommand({control:'brightness',operation:'get',targetId:"ID ' quoted"});
  assert.ok(command.includes("ID '' quoted"));
  assert.doesNotMatch(command,/Import-Module|Set-ExecutionPolicy|-ExecutionPolicy|\.psm1|Bypass/i);
});

test('wrapper rejects malformed, truncated and interrupted results',async()=>{
  const request={control:'brightness',operation:'get'} as const;
  for (const [json,success,truncated] of [['{}',true,false],['invalid',true,false],[JSON.stringify(snapshot(request)),false,false],[JSON.stringify(snapshot(request)),true,true]] as const) {
    const result=await executeWindowsControl(request,async()=>({success,timedOut:!success,steps:[{id:'test',status:success?'completed':'failed',stdout:json,stderr:'mock failure',durationMs:1,outputTruncated:truncated}]}));
    assert.equal(result.success,false);
  }
  const result=await executeWindowsControl(request,async()=>{throw new Error('mock launch denied');});
  assert.equal(result.error?.code,'executor_failure');
});

test('agent aliases report verified outcomes and preserve approval for new mutations',async()=>{
  const calls:WindowsControlRequest[]=[];
  const agent=new WindowsAgent(undefined,async request=>{calls.push(request);return {...snapshot(request),success:false,verification:{passed:false,kind:'test',waitedMs:0},error:{code:'access_denied',message:'Mock denied'}};});
  for (const action of ['brightness.set','bluetooth.enable','bluetooth.disable','windows.bluetooth_toggle']) {
    const result=await agent.execute(action,{targetId:'chosen',brightnessPercent:40,enabled:false});
    assert.equal(result.success,false); assert.equal(result.verification?.passed,false);
  }
  assert.deepEqual(calls[1],{control:'bluetooth',operation:'set',targetId:'chosen',state:'On'});
  assert.deepEqual(calls[3],{control:'bluetooth',operation:'set',targetId:'chosen',state:'Off'});
  const guard=new PermissionGuard(); guard.autonomousMode=true;
  for(const action of ['brightness.set','windows.brightness_set','bluetooth.set','bluetooth.enable','bluetooth.disable','windows.bluetooth_toggle']) {
    assert.equal(guard.check({id:'test',agent:'windows',action,params:{},risk:'low'} as Task,false),'confirm');
  }
});

test('manual CLI validates inputs and restores only after successful capture, even after partial failure',async()=>{
  for(const args of [['brightness','set','101'],['brightness','set','NaN'],['bluetooth','set','Toggle'],['brightness','list','--name','x'],['brightness','get','--test']]) assert.throws(()=>parseControlArgs(args));
  const calls:WindowsControlRequest[]=[];
  const execute=async(request:WindowsControlRequest)=>{
    calls.push(request);
    if(calls.length===2) throw new Error('Mock partial change');
    return snapshot(request);
  };
  const result=await runControlSmoke(['brightness','set','40','--name','Display','--test'],execute);
  assert.ok('success' in result && !result.success);
  assert.equal(calls.length,3);
  assert.deepEqual(calls[2],{control:'brightness',operation:'set',targetId:'chosen',brightnessPercent:90});
  calls.length=0;
  await assert.rejects(()=>runControlSmoke(['brightness','set','40','--test'],async request=>{calls.push(request);return {...snapshot(request),success:false};}));
  assert.equal(calls.length,1);
  calls.length=0;
  await runControlSmoke(['brightness','set','40'],async request=>{calls.push(request);return snapshot(request,40);});
  assert.equal(calls.length,1,'normal set must not restore');
});

const mockBackend=String.raw`
function Get-ControlDevices($Control) {
  $script:reads++
  switch ($script:mode) {
    'unsupported' { throw 'unsupported: Mock unsupported driver' }
    'missing' { return }
    'readFailure' { if($script:sets) { throw 'api_failure: Mock readback failed' } }
    'transient' { if($script:sets -and $script:reads -eq 2) { return } }
  }
  [pscustomobject]@{id='chosen';name='Friendly';brightnessPercent=$script:brightness;levels=@(0,40,90,100);state=$script:state}
  if($script:mode -eq 'ambiguous') { [pscustomobject]@{id='other';name='Friendly';brightnessPercent=90;state='On'} }
}
function Set-ControlDevice($Request,$Before) {
  $script:sets++
  switch ($script:mode) {
    'denied' { throw 'access_denied: Mock permission denied' }
    'apiFailure' { throw 'api_failure: Mock setter failed' }
    'asyncTimeout' { throw 'async_timeout: Mock WinRT timed out' }
    'mismatch' { return }
  }
  if($Request.control -eq 'brightness') { $script:brightness=$Request.brightnessPercent }
  else { $script:state=$Request.state }
}
`;

test('Windows: real controller rejects invalid requests before mutation, hardware absence, ambiguity, API/permission failures and bounded mismatch',win,async()=>{
  const cases:Array<{request:object;mode:string;success:boolean;code?:string}>=[];
  for(const request of [{},{control:'wifi',operation:'set'},{control:'brightness',operation:'set',brightnessPercent:101},{control:'brightness',operation:'set',brightnessPercent:'40'},{control:'brightness',operation:'set',brightnessPercent:true},{control:'brightness',operation:'get',brightnessPercent:40},{control:'brightness',operation:'set',brightnessPercent:41},{control:'bluetooth',operation:'set',state:'Toggle'},{control:'bluetooth',operation:'set',state:true},{control:'brightness',operation:'get',waitMs:0},{control:'brightness',operation:'get',targetId:''},{control:'brightness',operation:'get',targetId:'chosen',targetName:'Friendly'},{control:'brightness',operation:'list',targetId:'chosen'},{control:'brightness',operation:'get',unexpected:42}]) cases.push({request,mode:'normal',success:false});
  for(const control of ['brightness','bluetooth']) {
    for(const mode of ['missing','unsupported','ambiguous']) cases.push({request:{control,operation:'get'},mode,success:false});
    cases.push({request:{control,operation:'get',targetId:'missing'},mode:'normal',success:false,code:'target_missing'});
    for(const mode of ['normal','transient','denied','apiFailure','asyncTimeout','readFailure','mismatch']) cases.push({request:{control,operation:'set',targetId:'chosen',...(control==='brightness'?{brightnessPercent:40}:{state:'Off'}),waitMs:100},mode,success:['normal','transient'].includes(mode)});
  }
  const reports=await run(mockBackend+windowsControlsController+`\n$cases=${literal(JSON.stringify(cases))} | ConvertFrom-Json\n`+String.raw`
$reports=@()
foreach($case in $cases) {
  $script:mode=$case.mode;$script:sets=0;$script:reads=0;$script:brightness=90;$script:state='On'
  $result=Invoke-WindowsControl $case.request
  $reports+=@{result=$result;sets=$script:sets}
}
ConvertTo-Json -InputObject @($reports) -Depth 12 -Compress
`);
  cases.forEach((expected,i)=>{
    const actual=reports[i];assert.equal(actual.result.success,expected.success,JSON.stringify({expected,actual}));
    if(expected.code)assert.equal(actual.result.error.code,expected.code);
    if(expected.mode==='mismatch')assert.equal(actual.result.error.code,'readback_mismatch');
    if(expected.success){assert.equal(actual.result.verification.passed,true);assert.equal(actual.sets,1);}
    if(expected.request && (expected.request as any).operation!=='set')assert.equal(actual.sets,0);
  });
});

test('Windows: real brightness backend handles provider return shapes, verified restoration and clean friendly names',win,async()=>{
  const reports=await run(windowsControlsBackend+windowsControlsController+String.raw`
function Get-CimInstance {
  param($Namespace,$ClassName,$ErrorAction)
  switch($ClassName) {
    'WmiMonitorBrightnessMethods' { [pscustomobject]@{InstanceName='unchanged-ID';Active=$true} }
    'WmiMonitorBrightness' { [pscustomobject]@{InstanceName='unchanged-ID';Active=$true;CurrentBrightness=$script:brightness;Level=@(0..100)} }
    'WmiMonitorID' { if($script:name -eq 'missing') { [pscustomobject]@{InstanceName='unchanged-ID'} } else { [pscustomobject]@{InstanceName='unchanged-ID';UserFriendlyName=$script:name} } }
    default { throw 'Unexpected mocked CIM class' }
  }
}
function Invoke-CimMethod {
  param($InputObject,$MethodName,$Arguments,$ErrorAction)
  if($InputObject.InstanceName -cne 'unchanged-ID' -or $MethodName -ne 'WmiSetBrightness') { throw 'Wrong API target' }
  if($script:mode -eq 'denied') { throw 'access_denied: Mock CIM denied' }
  if($script:mode -ne 'mismatch') { $script:brightness=[int]$Arguments.Brightness }
  switch($script:mode) {
    'zero' { [pscustomobject]@{ReturnValue=0} }
    'empty' { [pscustomobject]@{} }
    'nullProperty' { [pscustomobject]@{ReturnValue=$null} }
    'nonzero' { [pscustomobject]@{ReturnValue=5} }
  }
}
$reports=@()
foreach($name in @(([char]0).ToString(),([uint16[]]@(0,0)),([char[]]@([char]0)),'missing',(' '+[char]0+' '),([uint16[]]@(32,9,68,69,76,76,32,0)))) {
  $script:name=$name;$script:brightness=90
  $reports+=@{kind='name';result=(Invoke-WindowsControl ([pscustomobject]@{control='brightness';operation='list'}))}
}
$script:name='Display'
foreach($mode in @('noOutput','empty','nullProperty','zero','nonzero','mismatch','denied')) {
  $script:mode=$mode;$script:brightness=90
  $change=Invoke-WindowsControl ([pscustomobject]@{control='brightness';operation='set';brightnessPercent=40;waitMs=100})
  $restore=$null
  if($change.success) { $restore=Invoke-WindowsControl ([pscustomobject]@{control='brightness';operation='set';targetId='unchanged-ID';brightnessPercent=90;waitMs=100}) }
  $reports+=@{kind='return';mode=$mode;change=$change;restore=$restore;final=$script:brightness}
}
ConvertTo-Json -InputObject @($reports) -Depth 12 -Compress
`);
  const names=reports.filter((r:any)=>r.kind==='name').map((r:any)=>r.result.observed.devices[0]);
  assert.deepEqual(names.map((d:any)=>d.name),[...Array(5).fill('Brightness-capable display'),'DELL']);
  assert.ok(names.every((d:any)=>d.id==='unchanged-ID'));
  for(const r of reports.filter((r:any)=>r.kind==='return')) {
    const good=['noOutput','empty','nullProperty','zero'].includes(r.mode);
    assert.equal(r.change.success,good,JSON.stringify(r));
    if(good){assert.equal(r.change.observed.brightnessPercent,40);assert.equal(r.restore.success,true);assert.equal(r.final,90);}
    else assert.equal(r.change.error.code,r.mode==='mismatch'?'readback_mismatch':r.mode==='denied'?'access_denied':'api_failure');
  }
});

test('Windows: actual Bluetooth setter honors access and API outcomes without touching radios',win,async()=>{
  const reports=await run(windowsControlsBackend+String.raw`
function Get-ControlRadioAccess { if($script:mode -eq 'denied') { return 'DeniedByUser' }; 'Allowed' }
function Get-ControlRadio($Id) {
  if($Id -cne 'radio-ID') { throw 'Wrong radio ID' }
  if($script:mode -eq 'missing') { return }
  [pscustomobject]@{Kind=$(if($script:mode -eq 'wrongKind'){'WiFi'}else{'Bluetooth'})}
}
function Set-ControlRadioState($Radio,$State) {
  $script:setCalls++
  if($State -cnotin @('On','Off')) { throw 'Wrong state passed to API' }
  if($script:mode -eq 'apiDenied') { return 'DeniedBySystem' }
  if($script:mode -eq 'timeout') { throw 'async_timeout: Mock timed out' }
  'Allowed'
}
$reports=@()
foreach($mode in @('normal','denied','missing','wrongKind','apiDenied','timeout')) {
  $script:mode=$mode;$script:setCalls=0;$errorText=$null
  try { Set-ControlDevice ([pscustomobject]@{control='bluetooth';state='On'}) ([pscustomobject]@{id='radio-ID'}) } catch { $errorText=$_.Exception.Message }
  $reports+=@{mode=$mode;error=$errorText;sets=$script:setCalls}
}
ConvertTo-Json -InputObject @($reports) -Depth 5 -Compress
`);
  for(const r of reports) {
    assert.equal(r.error===null,r.mode==='normal',JSON.stringify(r));
    if(['denied','missing','wrongKind'].includes(r.mode))assert.equal(r.sets,0);
  }
});

test('Windows: dist-only fresh actual executor, no inherited process policy/profile/src dependencies, repeated and new batches',win,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'vanessa-mvp-dist-'));
  try {
    const source=fileURLToPath(new URL('../../dist/agents/',import.meta.url));
    const agents=join(dir,'agents');await mkdir(agents);
    for(const file of ['powershell-executor.js','powershell-runner.js','windows-controls.js','windows-controls-backend.js','windows-controls-controller.js','windows-audio.js']) await cp(join(source,file),join(agents,file));
    await cp(join(source,'windows-audio'),join(agents,'windows-audio'),{recursive:true});
    await import('node:fs/promises').then(fs=>fs.writeFile(join(dir,'package.json'),'{"type":"module"}'));
    const code=`
      import assert from 'node:assert/strict';
      import {executePowerShellSteps} from ${JSON.stringify(pathToFileURL(join(agents,'powershell-executor.js')).href)};
      import {windowsControlCommand} from ${JSON.stringify(pathToFileURL(join(agents,'windows-controls.js')).href)};
      import {windowsAudioCommand} from ${JSON.stringify(pathToFileURL(join(agents,'windows-audio.js')).href)};
      const batches=[];
      for(let n=0;n<2;n++) {
        const result=await executePowerShellSteps({workingDirectory:${JSON.stringify(tmpdir())},timeoutMs:60000,steps:[
          {id:'environment',command:'[pscustomobject]@{version=$PSVersionTable.PSVersion.ToString();effectivePolicy=(Get-ExecutionPolicy).ToString();policies=@(Get-ExecutionPolicy -List | Select-Object Scope,ExecutionPolicy);cwd=(Get-Location).Path} | ConvertTo-Json -Depth 5 -Compress'},
          {id:'read-brightness',command:windowsControlCommand({control:'brightness',operation:'list'})},
          {id:'read-radio',command:windowsControlCommand({control:'bluetooth',operation:'list'})},
          {id:'repeat-brightness',command:windowsControlCommand({control:'brightness',operation:'list'})},
          {id:'read-audio',command:windowsAudioCommand({operation:'get'})},
          {id:'repeat-audio',command:windowsAudioCommand({operation:'get'})}
        ]});
        // Hardware discovery may honestly fail on a different host. This packaging
        // test on our actual device requires success; never silently skip failures.
        assert.equal(result.success,true,JSON.stringify(result));
        batches.push(result);
      }
      console.log(JSON.stringify(batches));
    `;
    // A PowerShell 7 parent can inject its incompatible module search path into
    // Windows PowerShell 5.1. Start with native defaults, not the terminal's path
    // or its optional temporary execution-policy environment variable.
    const env={...process.env};delete env.PSExecutionPolicyPreference;delete env.PSModulePath;
    const child=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:tmpdir(),env,encoding:'utf8',timeout:150000,windowsHide:true,maxBuffer:1024*1024});
    assert.equal(child.status,0,child.stderr+'\n'+child.stdout);
    const batches=JSON.parse(child.stdout);
    assert.equal(batches.length,2);
    const policy=JSON.parse(batches[0].steps[0].stdout);
    assert.ok(policy.version.startsWith('5.1'));
    console.log('Fresh executor effective execution policy: '+policy.effectivePolicy+'; read-only device counts: '+JSON.stringify({brightness:JSON.parse(batches[0].steps[1].stdout).observed.devices.length,bluetooth:JSON.parse(batches[0].steps[2].stdout).observed.devices.length}));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
