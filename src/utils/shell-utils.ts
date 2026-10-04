// Shell AST helpers. Duplicated from pi-toolchain since cross-extension imports are not allowed.

import type {
  ArithExpr,
  Command,
  Program,
  SimpleCommand,
  Statement,
  Word,
  WordPart,
} from "@aliou/sh";

/**
 * Resolve a Word node to its literal string value.
 * Concatenates Literal, SglQuoted, and simple DblQuoted parts.
 * For parts containing parameter expansions, command substitutions, etc.,
 * includes the raw text representation (e.g. `$VAR`).
 */
export function wordToString(word: Word): string {
  return word.parts.map(partToString).join("");
}

function partToString(part: WordPart): string {
  switch (part.type) {
    case "Literal":
      return part.value;
    case "SglQuoted":
      return part.value;
    case "DblQuoted":
      return part.parts.map(partToString).join("");
    case "ParamExp": {
      const parameter = `${part.length ? "#" : ""}${part.excl ? "!" : ""}${part.param.value}${part.index ? `[${wordToString(part.index)}]` : ""}`;
      if (part.short) return `$${parameter}`;
      const expansion = part.exp
        ? `${part.exp.op}${part.exp.word ? wordToString(part.exp.word) : ""}`
        : "";
      const slice = part.slice
        ? `:${wordToString(part.slice.offset)}${part.slice.length ? `:${wordToString(part.slice.length)}` : ""}`
        : "";
      const replacement = part.replace
        ? `${part.replace.all ? "//" : "/"}${part.replace.prefix ? "#" : part.replace.suffix ? "%" : ""}${wordToString(part.replace.orig)}/${part.replace.with ? wordToString(part.replace.with) : ""}`
        : "";
      return `\${${parameter}${slice}${expansion}${replacement}}`;
    }
    case "CmdSubst":
      return "$(...)";
    case "ArithExp":
      return `$((${arithmeticToString(part.x)}))`;
    case "ProcSubst":
      return `${part.op}(...)`;
    case "BraceExp":
      return `{${part.elems.map(wordToString).join(part.sequence ? ".." : ",")}}`;
    case "ExtGlob":
      return `${part.op}${part.pattern})`;
  }
}

function arithmeticToString(expression: ArithExpr): string {
  switch (expression.type) {
    case "ArithLit":
      return expression.value;
    case "ParamExp":
      return partToString(expression);
    case "BinaryArithm":
      return `${arithmeticToString(expression.x)} ${expression.op} ${arithmeticToString(expression.y)}`;
    case "UnaryArithm":
      if (expression.post) {
        return `${arithmeticToString(expression.x)}${expression.op}`;
      }
      return `${expression.op}${arithmeticToString(expression.x)}`;
    case "ParenArithm":
      return `(${arithmeticToString(expression.x)})`;
  }
}

/**
 * Walk the AST and call `callback` for every SimpleCommand found at any
 * nesting depth. Returns early if callback returns `true`.
 */
export function walkCommands(
  node: Program,
  callback: (cmd: SimpleCommand) => boolean | undefined,
): void {
  for (const stmt of node.body) {
    if (walkStatement(stmt, callback)) return;
  }
}

function walkStatement(
  stmt: Statement,
  callback: (cmd: SimpleCommand) => boolean | undefined,
): boolean {
  return walkCommand(stmt.command, callback);
}

function walkStatements(
  stmts: Statement[],
  callback: (cmd: SimpleCommand) => boolean | undefined,
): boolean {
  for (const stmt of stmts) {
    if (walkStatement(stmt, callback)) return true;
  }
  return false;
}

function walkCommand(
  cmd: Command,
  callback: (cmd: SimpleCommand) => boolean | undefined,
): boolean {
  switch (cmd.type) {
    case "SimpleCommand":
      return callback(cmd) === true;

    case "Pipeline":
      return walkStatements(cmd.commands, callback);

    case "Logical":
      return (
        walkStatement(cmd.left, callback) || walkStatement(cmd.right, callback)
      );

    case "Subshell":
    case "Block":
      return walkStatements(cmd.body, callback);

    case "IfClause":
      return (
        walkStatements(cmd.cond, callback) ||
        walkStatements(cmd.then, callback) ||
        (cmd.else ? walkStatements(cmd.else, callback) : false)
      );

    case "ForClause":
    case "SelectClause":
    case "WhileClause":
      return (
        ("cond" in cmd && cmd.cond
          ? walkStatements(cmd.cond, callback)
          : false) || walkStatements(cmd.body, callback)
      );

    case "CaseClause":
      for (const item of cmd.items) {
        if (walkStatements(item.body, callback)) return true;
      }
      return false;

    case "FunctionDecl":
      return walkStatements(cmd.body, callback);

    case "TimeClause":
      return walkStatement(cmd.command, callback);

    case "CoprocClause":
      return walkStatement(cmd.body, callback);

    case "CStyleLoop":
      return walkStatements(cmd.body, callback);

    case "TestClause":
    case "ArithCmd":
    case "DeclClause":
    case "LetClause":
      return false;
  }
}
