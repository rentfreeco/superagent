import path from "node:path";

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const COMMAND_SEPARATORS = new Set([";", "&", "|", "\n", "(", ")"]);

const findClosingParenthesis = (script: string, start: number): number => {
  let depth = 1;
  for (let index = start; index < script.length; index += 1) {
    if (script[index] === "(") depth += 1;
    if (script[index] === ")") depth -= 1;
    if (depth === 0) return index;
  }
  return script.length;
};

const findClosing = (script: string, quote: string, start: number): number => {
  const index = script.indexOf(quote, start);
  return index === -1 ? script.length : index;
};

const shellScripts = (words: readonly string[]): string[] => {
  const [program, ...args] = words;
  if (program === undefined || !SHELLS.has(path.basename(program))) return [];
  const scriptIndex = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
  const script = scriptIndex === -1 ? undefined : args[scriptIndex + 1];
  return script === undefined ? [] : [script];
};

/**
 * Splits a shell script into the words of each simple command it runs, so a
 * phrase inside a quoted argument isn't mistaken for a command. Commands in
 * $(…), backticks, subshells and `sh -c` scripts are split out too. It is a
 * best effort for a guard rail, not a shell parser.
 */
export const splitShellCommands = (script: string): string[][] => {
  const commands: string[][] = [];
  const nestedScripts: string[] = [];
  let words: string[] = [];
  let word = "";
  let hasWord = false;

  const endWord = (): void => {
    if (hasWord) words.push(word);
    word = "";
    hasWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index] ?? "";
    const next = script[index + 1];
    if (character === "'") {
      const closing = findClosing(script, "'", index + 1);
      word += script.slice(index + 1, closing);
      hasWord = true;
      index = closing;
    } else if (character === '"') {
      hasWord = true;
      for (
        index += 1;
        index < script.length && script[index] !== '"';
        index += 1
      ) {
        const quoted = script[index] ?? "";
        if (quoted === "\\" && index + 1 < script.length) {
          index += 1;
          word += script[index] ?? "";
        } else if (quoted === "$" && script[index + 1] === "(") {
          const closing = findClosingParenthesis(script, index + 2);
          nestedScripts.push(script.slice(index + 2, closing));
          index = closing;
        } else if (quoted === "`") {
          const closing = findClosing(script, "`", index + 1);
          nestedScripts.push(script.slice(index + 1, closing));
          index = closing;
        } else {
          word += quoted;
        }
      }
    } else if (character === "\\") {
      word += next ?? "";
      hasWord = true;
      index += 1;
    } else if (character === "$" && next === "(") {
      const closing = findClosingParenthesis(script, index + 2);
      nestedScripts.push(script.slice(index + 2, closing));
      hasWord = true;
      index = closing;
    } else if (character === "`") {
      const closing = findClosing(script, "`", index + 1);
      nestedScripts.push(script.slice(index + 1, closing));
      hasWord = true;
      index = closing;
    } else if (character === "#" && !hasWord) {
      index = findClosing(script, "\n", index) - 1;
    } else if (COMMAND_SEPARATORS.has(character)) {
      endCommand();
    } else if (/\s/.test(character)) {
      endWord();
    } else {
      word += character;
      hasWord = true;
    }
  }
  endCommand();

  return [
    ...commands,
    ...[...nestedScripts, ...commands.flatMap(shellScripts)].flatMap(
      splitShellCommands,
    ),
  ];
};
