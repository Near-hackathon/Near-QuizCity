import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { CityLoading } from "./CityLoading";
import { expectAccessible } from "../test/axe";

it("announces the loading stage and provides an accessible way to management", async () => {
  const { container, rerender } = render(<CityLoading message="Signing you in…" />);
  expect(screen.getByRole("status")).toHaveTextContent("Signing you in");
  expect(screen.getByRole("link", { name: "Open management" })).toHaveAttribute("href", "/manage");
  await expectAccessible(container);
  rerender(<CityLoading message="Connecting to the city…" overlay />);
  expect(screen.getByRole("status")).toHaveTextContent("Connecting to the city");
  await expectAccessible(container);
});
