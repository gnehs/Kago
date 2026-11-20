import type { CompanionRule } from "@/types/kago";

/**
 * The names of the files beside `name` that a previewer's rules point to: `name` with the first `replace` of each rule
 * swapped for its `with`, in the rules' order, once each. A rule whose `replace` is not in the name points nowhere, and
 * no rule can name the file itself or leave its folder.
 */
export function companionNames(name: string, rules: CompanionRule[]): string[] {
  const names: string[] = [];
  for (const rule of rules) {
    const at = name.indexOf(rule.replace);
    if (at < 0) continue;
    const other = name.slice(0, at) + rule.with + name.slice(at + rule.replace.length);
    if (other === name || other === "." || other === ".." || /[/\\\0]/.test(other) || names.includes(other)) continue;
    names.push(other);
  }
  return names;
}
