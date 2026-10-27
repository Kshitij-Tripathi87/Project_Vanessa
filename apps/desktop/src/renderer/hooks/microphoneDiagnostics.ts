export function explainMicrophoneFailure(error: unknown): string {
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: unknown }).name || "")
    : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Microphone permission is blocked. In Windows Settings → Privacy & security → Microphone, turn on Microphone access, Let apps access your microphone, and Let desktop apps access your microphone. Restart Vanessa after changing these settings.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone was found. Connect a microphone, then choose an input device in Windows Settings → System → Sound and try again.";
    case "NotReadableError":
    case "TrackStartError":
      return "Windows could not open the microphone. Close apps using it (such as Teams or a browser), check the selected input in Sound settings, and retry.";
    case "SecurityError":
      return "The microphone was blocked by the app security context. Close Vanessa and relaunch it using Launch-Vanessa.bat; do not open the renderer as a file or an unrelated web page.";
    case "NotSupportedError":
      return "This Vanessa runtime does not expose microphone capture. Restart the installed desktop app; typed commands are still available.";
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "The selected microphone does not support the requested audio format. Select another input device in Windows Sound settings and retry.";
    case "AbortError":
      return "Microphone startup was interrupted. Try starting voice again; typed commands remain available.";
    case "AudioContextUnavailableError":
      return "Vanessa could not initialize the audio engine. Restart the app and close other applications using audio; typed commands remain available.";
    default:
      return "Vanessa could not start microphone capture. Check Windows microphone privacy settings and the selected input device, then retry. Typed commands remain available.";
  }
}


/** RMS and peak for Web Audio's unsigned 8-bit time-domain samples (silence is near 128). */
export function measureMicrophoneSignal(samples: ArrayLike<number>): { rms: number; peak: number } {
  if (!samples || !Number.isFinite(samples.length) || samples.length <= 0) return { rms: 0, peak: 0 };
  let squaredSum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const raw = Number(samples[i]);
    if (!Number.isFinite(raw)) continue;
    const sample = Math.max(-1, Math.min(1, (raw - 128) / 128));
    squaredSum += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return { rms: Math.sqrt(squaredSum / samples.length), peak };
}

/** Conservative thresholds reject digital silence but work for ordinary speech near a laptop mic. */
export function hasMicrophoneSignal(measurement: { rms: number; peak: number }): boolean {
  return Number.isFinite(measurement.rms) && Number.isFinite(measurement.peak) &&
    (measurement.rms >= 0.012 || measurement.peak >= 0.06);
}
