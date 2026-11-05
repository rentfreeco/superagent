const splitSlackTs = (ts: string): readonly [number, number] => {
  const [seconds = "0", fraction = "0"] = ts.split(".");
  return [Number(seconds), Number(fraction.padEnd(6, "0"))];
};

export const compareSlackTs = (left: string, right: string): number => {
  const [leftSeconds, leftFraction] = splitSlackTs(left);
  const [rightSeconds, rightFraction] = splitSlackTs(right);
  return leftSeconds - rightSeconds || leftFraction - rightFraction;
};
