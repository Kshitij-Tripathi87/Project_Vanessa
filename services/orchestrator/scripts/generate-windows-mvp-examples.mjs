// Documentation only: builds ordinary executor requests; never executes them.
import { writeFile } from 'node:fs/promises';
import { windowsAudioCommand, windowsAudioHelperPath } from '../dist/agents/windows-audio.js';
import { windowsControlCommand } from '../dist/agents/windows-controls.js';
const request=(id,command)=>({workingDirectory:'services/orchestrator/dist',timeoutMs:30000,steps:[{id,command}]});
// Documentation examples run from the installed/repository dist directory.
// Keep generated docs portable; runtime code still uses the unchanged baseline
// import.meta-relative asset path and supports arbitrary working directories.
const assetLiteral="'"+windowsAudioHelperPath.replaceAll("'","''")+"'";
const audio=request=>windowsAudioCommand(request).replace(assetLiteral,"(Join-Path (Get-Location).Path 'agents/windows-audio/CoreAudio.cs')");
const examples={
  'audio-get':request('audio-get',audio({operation:'get'})),
  'audio-volume-30':request('audio-volume',audio({operation:'setVolume',volumePercent:30})),
  'audio-mute':request('audio-mute',audio({operation:'setMute',muted:true})),
  'audio-unmute':request('audio-unmute',audio({operation:'setMute',muted:false})),
  'brightness-list':request('brightness-list',windowsControlCommand({control:'brightness',operation:'list'})),
  'brightness-get':request('brightness-get',windowsControlCommand({control:'brightness',operation:'get',targetId:'<selected ID from brightness-list>'})),
  'brightness-set-40':request('brightness-set',windowsControlCommand({control:'brightness',operation:'set',targetId:'<selected ID from brightness-list>',brightnessPercent:40})),
  'bluetooth-list':request('bluetooth-list',windowsControlCommand({control:'bluetooth',operation:'list'})),
  'bluetooth-get':request('bluetooth-get',windowsControlCommand({control:'bluetooth',operation:'get',targetId:'<selected ID from bluetooth-list>'})),
  'bluetooth-on':request('bluetooth-on',windowsControlCommand({control:'bluetooth',operation:'set',targetId:'<selected ID from bluetooth-list>',state:'On'})),
  'bluetooth-off':request('bluetooth-off',windowsControlCommand({control:'bluetooth',operation:'set',targetId:'<selected ID from bluetooth-list>',state:'Off'})),
};
await writeFile(new URL('../../../docs/windows-mvp-examples.json',import.meta.url),JSON.stringify(examples,null,2)+'\n');
console.log('Wrote 11 focused executor JSON examples. Selected-ID placeholders must be replaced with discovered IDs. No settings changed.');
