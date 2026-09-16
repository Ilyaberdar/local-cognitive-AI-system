class DictationCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
    this.frames = 0;
    this.finished = false;
    this.port.onmessage = ({ data }) => {
      if (data === "flush") { this.flush(); this.finished = true; this.port.postMessage({ flushed: true }); }
    };
  }
  flush() {
    if (this.offset) {
      const samples = this.buffer.slice(0, this.offset);
      this.port.postMessage({ samples }, [samples.buffer]);
      this.offset = 0;
    }
  }
  process(inputs) {
    if (this.finished) return true;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] || 0;
      this.buffer[this.offset++] = sample / channels.length;
      this.frames++;
      if (this.offset === this.buffer.length) this.flush();
      if (this.frames >= sampleRate * 300) {
        this.flush(); this.finished = true; this.port.postMessage({ limit: true }); break;
      }
    }
    // Output stays silent. Connecting to destination keeps the worklet scheduled.
    return true;
  }
}
registerProcessor("dictation-capture", DictationCapture);
