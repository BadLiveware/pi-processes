import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

// pi-utils-ui removed these primitives; retain their borderless layout locally.
export function renderPanelRule(width: number, theme: Theme): string {
  return theme.fg("dim", "─".repeat(Math.max(0, width)));
}

export function renderPanelTitleLine(
  title: string,
  width: number,
  theme: Theme,
): string {
  const titleText = ` ${title} `;
  const borderLength = Math.max(0, width - visibleWidth(titleText));
  const leftBorder = Math.floor(borderLength / 2);
  const rightBorder = borderLength - leftBorder;

  return (
    theme.fg("dim", "─".repeat(leftBorder)) +
    theme.fg("accent", theme.bold(titleText)) +
    theme.fg("dim", "─".repeat(rightBorder))
  );
}

export function createPanelPadder(width: number): (content: string) => string {
  const innerWidth = Math.max(0, width - 2);
  return (content) =>
    ` ${content}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content)))} `;
}
