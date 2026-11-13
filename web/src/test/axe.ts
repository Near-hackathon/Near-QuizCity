import { axe } from "vitest-axe";
import { expect } from "vitest";

/**
 * jsdom has no canvas implementation, so axe's colour-contrast rule cannot run
 * faithfully here. It is excluded here and must be covered by a real-browser
 * accessibility run when Playwright is added.
 */
const axeOptions = {
  rules: {
    "color-contrast": { enabled: false },
  },
};

export async function expectAccessible(container: HTMLElement): Promise<void> {
  expect(await axe(container, axeOptions)).toHaveNoViolations();
}
