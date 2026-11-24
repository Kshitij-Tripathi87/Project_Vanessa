import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseLocalSpeechVoice, waitForLocalSpeechVoice } from "./localSpeechVoice.js";

function voice(name: string, localService: boolean, lang: string, isDefault = false): SpeechSynthesisVoice {
  return { name, localService, lang, default: isDefault, voiceURI: name };
}
class FakeSpeech extends EventTarget {
  voices: SpeechSynthesisVoice[] = [];
  getVoices() { return this.voices; }
}

test("local speech never selects an implicit or remote system voice", () => {
  const cloud = voice("Remote", false, "en-US", true);
  const local = voice("Local", true, "en-IN");
  assert.equal(chooseLocalSpeechVoice([], "en-US"), null);
  assert.equal(chooseLocalSpeechVoice([cloud], "en-US"), null);
  assert.equal(chooseLocalSpeechVoice([cloud, local], "en-US"), local);
  assert.equal(chooseLocalSpeechVoice([local, voice("Exact", true, "en-US")], "en-US")?.name, "Exact");
});

test("local speech waits for asynchronous voices and times out without falling back to cloud", async () => {
  const speech = new FakeSpeech();
  const result = waitForLocalSpeechVoice(speech as unknown as SpeechSynthesis, "en-US", 100);
  speech.voices = [voice("remote", false, "en-US"), voice("local", true, "en-US")];
  speech.dispatchEvent(new Event("voiceschanged"));
  assert.equal((await result)?.name, "local");
  const remoteOnly = new FakeSpeech();
  remoteOnly.voices = [voice("remote", false, "en-US", true)];
  assert.equal(await waitForLocalSpeechVoice(remoteOnly as unknown as SpeechSynthesis, "en-US", 5), null);
});
