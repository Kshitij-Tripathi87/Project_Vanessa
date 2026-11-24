/** Choose only voices that Chromium/OS identifies as local; never use the implicit default. */
export function chooseLocalSpeechVoice(voices: readonly SpeechSynthesisVoice[], language = ""): SpeechSynthesisVoice | null {
  const local = voices.filter((voice) => voice.localService === true);
  if (!local.length) return null;
  const requested = language.toLowerCase();
  const primary = requested.split("-")[0];
  return local.find((voice) => requested && voice.lang.toLowerCase() === requested)
    || local.find((voice) => primary && voice.lang.toLowerCase().split("-")[0] === primary)
    || local.find((voice) => voice.default)
    || local[0];
}

/** Voice lists can load asynchronously on desktop. Wait briefly, then fail closed. */
export function waitForLocalSpeechVoice(speech: SpeechSynthesis, language = "", timeoutMs = 1500): Promise<SpeechSynthesisVoice | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (voice: SpeechSynthesisVoice | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      speech.removeEventListener("voiceschanged", check);
      resolve(voice);
    };
    const check = () => {
      try {
        const voice = chooseLocalSpeechVoice(speech.getVoices(), language);
        if (voice) finish(voice);
      } catch { finish(null); }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    speech.addEventListener("voiceschanged", check);
    check();
  });
}
