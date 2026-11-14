import { describe, expect, it } from "vitest";
import { resolveApiBase } from "./api-base";

describe("resolveApiBase", () => {
  it("uses the local Fastify server during development", () => {
    expect(resolveApiBase(undefined, true, "http://localhost:5173")).toBe("http://localhost:8787");
  });

  it("uses the page origin in production when no override is supplied", () => {
    expect(resolveApiBase(undefined, false, "https://quiz-city.pages.dev/")).toBe(
      "https://quiz-city.pages.dev",
    );
  });

  it("normalizes an explicitly configured API origin", () => {
    expect(resolveApiBase(" https://api.example.test/// ", false, "https://quiz-city.pages.dev")).toBe(
      "https://api.example.test",
    );
  });
});
