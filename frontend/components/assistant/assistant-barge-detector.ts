// PCM arrives at 16 kHz. This is an activity gate, not speaker identification.
export function createBargeDetector() {
  let samplesSeen = 0;
  let frameSamples = 0;
  let energy = 0;
  let crossings = 0;
  let previous = 0;
  let sustained = 0;
  let detected = false;
  return (samples: Int16Array) => {
    for (const sample of samples) {
      samplesSeen++;
      const value = sample / 32768;
      energy += value * value;
      if ((value >= 0) !== (previous >= 0)) crossings++;
      previous = value;
      if (++frameSamples < 320) continue;
      const rms = Math.sqrt(energy / frameSamples);
      const crossingRate = crossings / frameSamples;
      // Ignore the first second and require 600 ms of consecutive activity.
      if (samplesSeen > 16000 && rms >= 0.035 && crossingRate >= 0.015 && crossingRate <= 0.35) sustained++;
      else sustained = 0;
      frameSamples = 0; energy = 0; crossings = 0;
      if (sustained >= 30 && !detected) { detected = true; return true; }
    }
    return false;
  };
}
