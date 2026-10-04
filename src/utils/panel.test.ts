import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  createPanelPadder,
  renderPanelRule,
  renderPanelTitleLine,
} from "./panel";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
} as Theme;

describe("legacy panel layout", () => {
  it("retains full-width borderless rules", () => {
    expect(renderPanelRule(6, theme)).toBe("──────");
    expect(renderPanelRule(0, theme)).toBe("");
  });

  it("retains centered, bold titles without box corners", () => {
    const line = renderPanelTitleLine("Logs", 12, theme);
    expect(line).toBe(`───\u001b[1m Logs \u001b[22m───`);
    expect(visibleWidth(line)).toBe(12);
  });

  it("pads ANSI and wide characters with spaces rather than vertical borders", () => {
    const content = theme.bold("界");
    const line = createPanelPadder(8)(content);
    expect(line).toBe(` ${content}     `);
    expect(visibleWidth(line)).toBe(8);
  });
});
