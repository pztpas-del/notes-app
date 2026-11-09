// Everything the app uses from CodeMirror, bundled into docs/vendor/codemirror.js
// so the app works offline and needs no CDN. Rebuild: npm run build:editor
export { EditorState, EditorSelection, StateField, StateEffect, Annotation, RangeSetBuilder, Prec, Compartment, Transaction } from '@codemirror/state';
export { EditorView, ViewPlugin, Decoration, WidgetType, keymap, drawSelection, highlightActiveLine, placeholder, dropCursor } from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
export { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
export { syntaxTree, syntaxHighlighting, HighlightStyle, indentUnit } from '@codemirror/language';
export { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
export { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
export { tags } from '@lezer/highlight';
