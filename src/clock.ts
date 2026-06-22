export const nowMs = () => Date.now();
export const nowSec = () => Math.floor(Date.now() / 1000);

export const windowStart = (n: number, w: number) => n - (n % w);
export const windowClose = (n: number, w: number) => windowStart(n, w) + w;
export const secsRemaining = (n: number, w: number) => windowClose(n, w) - n;

export function slugFor(asset: string, interval: string, n: number, windowSec: number): string {
  return `${asset.toLowerCase()}-updown-${interval}-${windowStart(n, windowSec)}`;
}