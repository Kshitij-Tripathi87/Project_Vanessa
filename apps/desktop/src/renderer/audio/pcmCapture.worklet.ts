declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor,
): void;

class VanessaPcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (input && input.length > 0) {
      const samples = new Float32Array(input);
      this.port.postMessage(samples, [samples.buffer]);
    }

    // Keep the node alive without routing microphone audio to the speakers.
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    return true;
  }
}

registerProcessor("vanessa-pcm-capture", VanessaPcmCaptureProcessor);
