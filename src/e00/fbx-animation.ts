const frameRates = new Map([
  [0, 30], [1, 120], [2, 100], [3, 60], [4, 50], [5, 48], [6, 30], [7, 30], [8, 30 / 1.001],
  [9, 30 / 1.001], [10, 25], [11, 24], [12, 1000], [13, 24 / 1.001], [15, 96], [16, 72], [17, 60 / 1.001],
]);

export function fbxFrameRate(mode?: number, custom?: number) {
  if (mode === 14 && custom !== undefined && Number.isFinite(custom) && custom > 0) return custom;
  return mode === undefined ? undefined : frameRates.get(mode);
}

const timeIndependentAutoCubic = 0x2108;
const maxCurveError = .005;
const maxSubdivisionDepth = 5;

// Unweighted, time-independent FBX auto tangents use the secant across neighboring keys.
// Sample the cubic for the working animation, whose transform tracks interpolate linearly or spherically.
export function sampleFbxAutoCurve(times: number[], values: number[], flags?: number[], counts?: number[]) {
  if (times.length < 2 || times.length !== values.length || !flags?.length || flags.length !== counts?.length ||
      flags.some(flag => flag !== timeIndependentAutoCubic) || counts.some(count => !Number.isSafeInteger(count) || count < 1) ||
      counts.reduce((sum, count) => sum + count, 0) !== times.length ||
      times.some((time, i) => !Number.isFinite(time) || i > 0 && time <= times[i - 1]) || !values.every(Number.isFinite)) return;
  const result = { times: [times[0]], values: [values[0]] };
  const slope = times.map((_, i) => {
    const left = Math.max(0, i - 1), right = Math.min(times.length - 1, i + 1);
    return (values[right] - values[left]) / (times[right] - times[left]);
  });
  for (let i = 0; i + 1 < times.length; i++) {
    const duration = times[i + 1] - times[i], a = values[i], b = values[i + 1];
    const outgoing = duration * slope[i], incoming = duration * slope[i + 1];
    const sample = (t: number) => a + t * (outgoing + t * (3 * (b - a) - 2 * outgoing - incoming + t * (2 * (a - b) + outgoing + incoming)));
    function append(left: number, right: number, start: number, stop: number, depth: number) {
      const width = right - left, middle = left + width / 2;
      if (depth < maxSubdivisionDepth && [.25, .5, .75].some(fraction =>
        Math.abs(sample(left + fraction * width) - (start + fraction * (stop - start))) > maxCurveError)) {
        const half = sample(middle);
        append(left, middle, start, half, depth + 1);
        append(middle, right, half, stop, depth + 1);
        return;
      }
      result.times.push(right === 1 ? times[i + 1] : times[i] + right * duration);
      result.values.push(stop);
    }
    append(0, 1, a, b, 0);
  }
  return result;
}
