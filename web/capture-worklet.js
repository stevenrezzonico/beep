/**
 * Capture worklet: copies the first input channel into fixed-size blocks and posts them to the
 * main thread (buffers are transferred, not copied). All DSP happens elsewhere; this stays tiny
 * so it can never glitch the audio thread. Outputs silence (the node is connected through a
 * zero-gain node only so that every browser keeps pulling it).
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const size = (options && options.processorOptions && options.processorOptions.blockSize) || 2048;
    this.size = size;
    this.buf = new Float32Array(size);
    this.fill = 0;
    this.frames = 0; // input frames seen, lets the main thread detect dropouts
    this.active = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.active = false;
    };
  }

  process(inputs) {
    if (!this.active) return false;
    const ch = inputs[0] && inputs[0][0];
    const n = ch ? ch.length : 128;
    for (let i = 0; i < n; i++) {
      this.buf[this.fill++] = ch ? ch[i] : 0;
      if (this.fill === this.size) {
        this.port.postMessage({ samples: this.buf, frame: this.frames + i + 1 - this.size, time: currentTime }, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.fill = 0;
      }
    }
    this.frames += n;
    return true;
  }
}

registerProcessor('beep-capture', CaptureProcessor);
