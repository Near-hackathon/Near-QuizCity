type Sample = { x: number; y: number; time: number; sequence: string };
export class InterpolationBuffer {
  private samples: Sample[] = [];
  push(sample: Sample) {
    const last = this.samples.at(-1);
    if (last && BigInt(sample.sequence) <= BigInt(last.sequence)) return;
    if (last && Math.hypot(sample.x - last.x, sample.y - last.y) > 2) this.samples = [];
    this.samples.push(sample);
    this.samples = this.samples.slice(-8);
  }
  position(now: number) {
    const last = this.samples.at(-1);
    if (!last) return null;
    const target = now - 100;
    const right = this.samples.findIndex((sample) => sample.time >= target);
    if (right <= 0) return right === 0 ? this.samples[0] : last;
    const a = this.samples[right - 1],
      b = this.samples[right];
    const t = Math.min(1, Math.max(0, (target - a.time) / Math.max(1, b.time - a.time)));
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
}
