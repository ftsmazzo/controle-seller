export function mae(actual: number[], predicted: number[]): number {
  if (!actual.length) return 0;
  let sum = 0;
  for (let i = 0; i < actual.length; i += 1) sum += Math.abs(actual[i]! - predicted[i]!);
  return sum / actual.length;
}

export function rmse(actual: number[], predicted: number[]): number {
  if (!actual.length) return 0;
  let sum = 0;
  for (let i = 0; i < actual.length; i += 1) {
    const err = actual[i]! - predicted[i]!;
    sum += err * err;
  }
  return Math.sqrt(sum / actual.length);
}

export function mape(actual: number[], predicted: number[], eps = 100): number {
  if (!actual.length) return 0;
  let sum = 0;
  for (let i = 0; i < actual.length; i += 1) {
    const denom = Math.max(Math.abs(actual[i]!), eps);
    sum += Math.abs(actual[i]! - predicted[i]!) / denom;
  }
  return sum / actual.length;
}

export function summarize(actual: number[], predicted: number[]) {
  return { mae: mae(actual, predicted), mape: mape(actual, predicted), rmse: rmse(actual, predicted) };
}
