import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { sanitizeForDisplay } from "../../../shared/display-text";

export function buildLegacyContent(text: string, theme: Theme): Container {
  const container = new Container();
  container.addChild(
    new Text(theme.fg("muted", sanitizeForDisplay(text)), 0, 0),
  );
  return container;
}
