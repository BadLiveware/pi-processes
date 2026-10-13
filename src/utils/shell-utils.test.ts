import { parseWordsSeq, splitBraces } from "@aliou/sh";
import { describe, expect, it } from "vitest";
import { wordToString } from "./shell-utils";

const parameter = (expression: string) => `\${${expression}}`;

describe("wordToString", () => {
  it.each([
    "$HOME",
    parameter("HOME:-fallback"),
    parameter("name/old/new"),
    parameter("name//old/new"),
    parameter("name/#old/new"),
    parameter("name/%old/new"),
    parameter("name:1:2"),
    parameter("arr[0]"),
    parameter("#name"),
    parameter("!name"),
    "@(foo|bar)",
  ])("retains expansion syntax for %s", (source) => {
    const [word] = [...parseWordsSeq(source)];
    expect(wordToString(word)).toBe(source);
  });

  it.each(["{a,b}", "{1..5}"])(
    "retains split brace syntax for %s",
    (source) => {
      const [word] = [...parseWordsSeq(source)];
      expect(splitBraces(word)).toBe(true);
      expect(wordToString(word)).toBe(source);
    },
  );

  it.each(["$((1 + 2))", "$((-(1 + 2)))", "$((1 * (2 + 3)))"])(
    "renders arithmetic syntax for %s",
    (source) => {
      const [word] = [...parseWordsSeq(source)];
      expect(wordToString(word)).toBe(source);
    },
  );
});
