import "vitest";
import type { AxeMatchers } from "vitest-axe/matchers";

declare module "vitest" {
  interface Assertion<T = any> extends AxeMatchers {
    readonly __vitestAxe?: T;
  }
  interface AsymmetricMatchersContaining extends AxeMatchers {
    readonly __vitestAxe?: unknown;
  }
}
