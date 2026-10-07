import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState, type Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

/** The text as it will be written, and a way to say that it was: the editor counts changes from the last commit. */
export type CodeEditorHandle = { snapshot: () => { text: string; commit: () => void }; focus: () => void };

type Props = {
  ref: Ref<CodeEditorHandle>;
  fileName: string;
  initial: string;
  /** Set for a file with Windows line endings, so that saving leaves them as they were. */
  lineSeparator?: string;
  readOnly: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: () => void;
  onCursor: (line: number, column: number) => void;
  onLanguage: (name: string) => void;
};

const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

// Everything is a design token, so the editor follows the theme without being rebuilt.
const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--kago-text)", backgroundColor: "var(--kago-surface)", fontSize: "12.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: mono, lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--kago-text)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--kago-text)" },
  ".cm-gutters": { color: "var(--kago-text-faint)", backgroundColor: "var(--kago-surface)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--kago-hover)" },
  ".cm-activeLineGutter": { color: "var(--kago-text-muted)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--kago-accent-soft)" },
  ".cm-selectionMatch": { backgroundColor: "var(--kago-hover)" },
  ".cm-searchMatch": { backgroundColor: "var(--kago-code-match)", outline: "none" },
  ".cm-searchMatch.cm-searchMatch-selected": { outline: "1px solid var(--kago-accent)" },
  "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": { backgroundColor: "var(--kago-hover)", outline: "1px solid var(--kago-border-strong)" },
  ".cm-foldPlaceholder": { color: "var(--kago-text-muted)", backgroundColor: "var(--kago-surface-elevated)", border: "1px solid var(--kago-border)" },
  ".cm-panels": { color: "var(--kago-text)", backgroundColor: "var(--kago-surface-elevated)", fontFamily: "var(--font-sans)", fontSize: "var(--kago-font-size)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--kago-border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--kago-border)" },
  ".cm-panel.cm-search": { padding: "6px 28px 6px 8px" },
  ".cm-panel.cm-search label": { display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "inherit" },
  ".cm-panel.cm-search [name=close]": { top: "4px", right: "8px", color: "var(--kago-text-muted)", fontSize: "16px" },
  ".cm-textfield": { height: "24px", color: "var(--kago-text)", backgroundColor: "var(--kago-surface)", border: "1px solid var(--kago-border-strong)", borderRadius: "var(--kago-radius-md)", fontSize: "inherit" },
  ".cm-textfield:focus": { outline: "none", borderColor: "var(--kago-accent)" },
  ".cm-button": { height: "24px", color: "var(--kago-text)", backgroundColor: "var(--kago-surface)", backgroundImage: "none", border: "1px solid var(--kago-border)", borderRadius: "var(--kago-radius-md)", fontSize: "inherit" },
  ".cm-button:active": { backgroundImage: "none", backgroundColor: "var(--kago-hover)" },
  ".cm-tooltip": { color: "var(--kago-text)", backgroundColor: "var(--kago-surface)", border: "none", borderRadius: "var(--kago-radius-md)", boxShadow: "var(--kago-shadow-popup)", overflow: "hidden" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { color: "var(--kago-accent-fg)", backgroundColor: "var(--kago-accent)" }
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.definitionKeyword, t.bool, t.null, t.atom, t.self], color: "var(--kago-code-keyword)" },
  { tag: [t.controlKeyword, t.moduleKeyword, t.processingInstruction], color: "var(--kago-code-control)" },
  { tag: [t.string, t.special(t.string), t.character, t.regexp, t.escape, t.inserted], color: "var(--kago-code-string)" },
  { tag: [t.number, t.unit, t.color], color: "var(--kago-code-number)" },
  { tag: [t.comment, t.meta], color: "var(--kago-code-comment)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.labelName], color: "var(--kago-code-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.annotation], color: "var(--kago-code-type)" },
  { tag: [t.variableName, t.propertyName, t.definition(t.variableName)], color: "var(--kago-code-variable)" },
  { tag: [t.tagName, t.heading], color: "var(--kago-code-tag)" },
  { tag: t.attributeName, color: "var(--kago-code-attribute)" },
  { tag: [t.link, t.url], color: "var(--kago-accent)", textDecoration: "underline" },
  { tag: t.heading, fontWeight: "600" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.deleted, t.invalid], color: "var(--kago-danger)" }
]);

// The find panel is the one piece of CodeMirror with words of its own.
const phrases = EditorState.phrases.of({
  Find: "尋找",
  Replace: "取代",
  next: "下一個",
  previous: "上一個",
  all: "全部",
  "match case": "區分大小寫",
  regexp: "正規表示式",
  "by word": "全字相符",
  replace: "取代",
  "replace all": "全部取代",
  close: "關閉",
  "Go to line": "前往行",
  go: "前往",
  "Folded lines": "已摺疊的行",
  "Fold line": "摺疊",
  "Unfold line": "展開"
});

/** CodeMirror for one file. It is created once from `initial`; the parent remounts it to load other text. */
export default function CodeEditor({ ref, fileName, initial, lineSeparator, readOnly, ...callbacks }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saved = useRef<Text | null>(null);
  const latest = useRef(callbacks);
  latest.current = callbacks;

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    snapshot() {
      const state = view.current!.state;
      return {
        text: state.sliceDoc(),
        commit() {
          saved.current = state.doc;
          if (view.current) latest.current.onDirty(!view.current.state.doc.eq(state.doc));
        }
      };
    }
  }));

  useEffect(() => {
    const language = new Compartment();
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                latest.current.onSave();
                return true;
              }
            },
            indentWithTab
          ]),
          lineSeparator ? EditorState.lineSeparator.of(lineSeparator) : [],
          EditorState.readOnly.of(readOnly),
          language.of([]),
          syntaxHighlighting(highlight),
          theme,
          phrases,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onDirty(!update.state.doc.eq(saved.current!));
            if (update.docChanged || update.selectionSet) reportCursor(update.state);
          })
        ]
      })
    });
    const reportCursor = (state: EditorState) => {
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      latest.current.onCursor(line.number, head - line.from + 1);
    };
    view.current = editor;
    saved.current = editor.state.doc;
    editor.focus();

    // Each grammar is its own chunk, fetched only for a file that needs it.
    let disposed = false;
    const description = LanguageDescription.matchFilename(languages, fileName);
    latest.current.onLanguage(description?.name ?? "純文字");
    void description?.load().then(
      (support) => !disposed && editor.dispatch({ effects: language.reconfigure(support) }),
      () => undefined
    );

    return () => {
      disposed = true;
      view.current = null;
      editor.destroy();
    };
  }, [fileName, initial, lineSeparator, readOnly]);

  return <div ref={host} className="size-full min-h-0 overflow-hidden" />;
}
