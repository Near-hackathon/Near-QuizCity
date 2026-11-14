export type InputGate = {
  hidden: boolean;
  online: boolean;
  uiModalOpen: boolean;
  transitioning: boolean;
  reducedMotion?: boolean;
};
export function canSampleInput(gate: InputGate) {
  return !gate.hidden && gate.online && !gate.uiModalOpen && !gate.transitioning;
}
export function inputDirection(dx: number, dy: number): { x: number; y: number } {
  const length = Math.hypot(dx, dy);
  return length === 0 ? { x: 0, y: 0 } : { x: dx / length, y: dy / length };
}
