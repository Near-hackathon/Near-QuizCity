import "@testing-library/jest-dom/vitest";
import "vitest-axe/extend-expect";
import * as matchers from "vitest-axe/matchers";
import { expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

expect.extend(matchers);

let unexpectedConsole: string[] = [];

beforeEach(() => {
  unexpectedConsole = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    unexpectedConsole.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    unexpectedConsole.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  const messages = unexpectedConsole;
  unexpectedConsole = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (messages.length > 0) {
    throw new Error(`unexpected console output:\n${messages.join("\n")}`);
  }
});
