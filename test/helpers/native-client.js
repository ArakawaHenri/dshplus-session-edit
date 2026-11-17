import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const browserReact = {
  name: 'fixture-react',
  setup(builder) {
    builder.onResolve({ filter: /^react(?:-dom|\/jsx-runtime)?$/ }, args => ({ path: args.path, namespace: 'fixture-react' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture-react' }, args => ({
      contents: args.path === 'react/jsx-runtime'
        ? 'exports.Fragment = window.React.Fragment; exports.jsx = exports.jsxs = (type, props, key) => window.React.createElement(type, {...props, key});'
        : 'module.exports = window.' + (args.path === 'react' ? 'React' : 'ReactDOM') + ';',
    }));
  },
};

function region(source, name) {
  const marker = '//#region lib/types/' + name + '.js';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'Native DSH region missing: ' + name);
  return source.slice(start + marker.length, source.indexOf('//#endregion', start));
}

async function bundle(contents, resolveDir, plugins = []) {
  const result = await build({
    stdin: { contents, resolveDir }, bundle: true, format: 'iife', write: false, jsx: 'automatic',
    outfile: 'fixture.js', loader: { '.css': 'local-css' }, plugins: [browserReact, ...plugins],
  });
  return {
    js: result.outputFiles.find(file => file.path.endsWith('.js')).text,
    css: result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '',
  };
}

// Read the published components rather than maintaining lookalike controls.
// Unrelated Markdown/highlighter code is omitted so its dependencies are not
// needed just to test the host's Button, InlineEditor, Menu, Modal and Tooltip.
export async function nativeClientFixture() {
  const primitivesPath = require.resolve('@deepseek-ai/dsh-client-ui-primitives');
  const source = await readFile(primitivesPath, 'utf8');
  const names = [
    'icons/artwork', 'icons/index', 'Button', 'InlineEditor',
    'overlay-top-margin', 'keyboard-composition', 'focus', 'useModalLayer',
    'ShortcutKeys', 'MenuSurface', 'Menu', 'MenuGroup', 'useAnchoredMaxHeight',
    'useDismissOnOutsidePointer', 'clipboard',
    'Modal', 'input-modality', 'Tooltip', 'Toast',
  ];
  const body = names.map(name => region(source, name)).join('\n');
  // Keep the React/utility imports the extracted regions resolve through, plus
  // the CSS modules whose bindings they actually reference.
  const imports = source.split('\n').flatMap(line => {
    if (!/^import /.test(line)) return [];
    const match = line.match(/^import\s+(.*?)\s*from\s*"([^"]+)";?$/);
    if (!match) return [];
    const [, clause, specifier] = match;
    if (/^(?:react|react-dom|react\/jsx-runtime|clsx)$/.test(specifier)) return [line];
    if (!specifier.endsWith('.css')) return [];
    const bindings = clause.replace(/[{}]/g, ' ').split(',')
      .map(part => part.trim().replace(/^\*\s+as\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(name => /^[A-Za-z_$][\w$]*$/.test(name));
    return bindings.some(name => new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(body)) ? [line] : [];
  }).join('\n');
  const primitives = await bundle(imports + '\n' + body + `
    window.NativeUI = { Button, InlineEditor, Menu, MenuItemButton, Modal, Toast, Tooltip, writeClipboard,
      focusWithoutRing, isMobileDevice,
      IconEditOutlineRegular, IconRefreshOutlineRegular, IconCopyOutlineRegular,
      IconCheckOutlineRegular, IconBranchOutlineRegular, IconTriangleRightFillRegular,
      IconEllipsisOutlineRegular, IconWarningOutlineRegular, IconPlusOutlineMedium };
  `, dirname(primitivesPath));

  // DSH 0.2.2 minifies the conversation client bundle, so its composer is read
  // from the published source instead of named build regions. Only the Lexical
  // editor, the DOM bindings that drive it, and external services are replaced;
  // the InputBar body, its styles and its submission policy stay real.
  const conversationPath = require.resolve('@deepseek-ai/dsh-client-ui-conversation/client');
  const conversationRoot = dirname(dirname(conversationPath));
  const composerStubs = {
    '../input/editor/DraftEditor.tsx': `
      import * as react from 'react';
      export function DraftEditor({editable, ariaLabel}) {
        const ref = react.useRef(null);
        const draft = window.fixture.useInput(input => input.draft);
        react.useLayoutEffect(() => {
          if (ref.current.textContent !== draft) ref.current.textContent = draft;
        }, [draft]);
        return react.createElement('div', {
          ref, role: 'textbox', 'aria-label': ariaLabel, contentEditable: editable,
          suppressContentEditableWarning: true, 'data-testid': 'native-draft',
          onInput: event => window.fixture.setInput({draft: event.currentTarget.textContent}),
        });
      }`,
    '../input/editor/view-binding.ts': `
      export const focusDraftEditor = () => {};
      export const installDraftFilePicker = () => () => {};
      export const installDraftKeyboardDismissal = () => () => {};
      export const installDraftKeymap = () => () => {};
      export const installDraftWheel = () => () => {};
      export const keepDraftFocus = event => event.preventDefault();
      export const revealDraftSelection = () => {};`,
    '../service.ts': `
      export const isImageMediaType = value =>
        ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value);`,
    './ContextMeter.tsx': 'export const ContextMeter = () => null;',
    './control-row-layout.ts': 'export const observeControlRow = () => () => {};',
    '../../submission-settings.ts': `
      export const BUSY_ENTER_FIELD = 'busyEnter';
      export const DEFAULT_BUSY_ENTER_BEHAVIOR = 'queue';`,
    '@deepseek-ai/dsh-client-store': `
      export const createSnapshotStore = initial => ({ getState: () => initial, subscribe: () => () => {} });`,
  };

  const composerStub = {
    name: 'fixture-composer',
    setup(builder) {
      builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ },
        () => ({ path: 'primitives', namespace: 'fixture-primitives' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture-primitives' },
        () => ({ contents: 'module.exports = window.NativeUI;', loader: 'js' }));
      builder.onResolve({ filter: /^(?:\.\.\/(?:input\/editor\/(?:DraftEditor\.tsx|view-binding\.ts)|service\.ts)|\.\/(?:ContextMeter\.tsx|control-row-layout\.ts)|\.\.\/\.\.\/submission-settings\.ts|@deepseek-ai\/dsh-client-store)$/ },
        args => ({ path: args.path, namespace: 'fixture-composer' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture-composer' }, args => {
        const contents = composerStubs[args.path];
        assert.ok(contents, 'Unexpected composer dependency: ' + args.path);
        return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' };
      });
    },
  };

  const composer = await bundle(`
    import { InputBar } from ${JSON.stringify(join(conversationRoot, 'src/client/skeleton/InputBar.tsx'))};
    import { en } from ${JSON.stringify(join(conversationRoot, 'src/client/locales.ts'))};
    window.NativeInputBar = InputBar;
    window.NativeConversationLocale = en;
  `, conversationRoot, [composerStub]);
  return {
    js: primitives.js + '\n' + composer.js,
    css: primitives.css + '\n' + composer.css,
  };
}
