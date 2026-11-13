import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "../test/axe";
import { describe, expect, it, vi } from "vitest";
import { CityGrid, money, short } from "./CityGrid";
import type { Property } from "../api";

const property: Property = {
  id: "1",
  district: "knowledge",
  x: 1,
  y: 1,
  owner_wallet: "player:alice.testnet",
  property_type: "venue",
  price: "300",
  for_sale: true,
  transfer_count: "1",
};

describe("CityGrid", () => {
  it("formats large exact QC strings without precision loss", () => {
    expect(money("9007199254740993")).toBe("9,007,199,254,740,993");
    expect(money("0")).toBe("0");
    expect(short("player:alice-quizcity.testnet")).toBe("alice");
  });

  it("selects a property by click and keyboard", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<CityGrid properties={[property]} selectedId={null} onSelect={onSelect} />);
    const tile = screen.getAllByRole("button")[1 * 8 + 1];
    await user.click(tile);
    expect(onSelect).toHaveBeenLastCalledWith("1");

    tile.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("1");
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenLastCalledWith("1");
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("clears the selection for an empty tile and marks the selected tile", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(<CityGrid properties={[property]} selectedId={null} onSelect={onSelect} />);
    await user.click(screen.getAllByRole("button")[0]);
    expect(onSelect).toHaveBeenCalledWith(null);

    rerender(<CityGrid properties={[property]} selectedId={"1"} onSelect={onSelect} />);
    expect(screen.getAllByRole("button")[9]).toHaveClass("selected");
  });

  it("has no serious accessibility violations", async () => {
    const { container } = render(<CityGrid properties={[property]} selectedId={null} onSelect={vi.fn()} />);
    await expectAccessible(container);
  });
});
