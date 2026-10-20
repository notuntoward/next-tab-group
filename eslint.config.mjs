import globals from 'globals';
import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

const BARE_WINDOW_GLOBALS = ['document', 'window', 'navigator', 'localStorage'].map((name) => ({
  name,
  message: 'Bare main-window global. Use activeWindow/activeDocument, el.ownerDocument, evt.view, or a passed-in Window.',
}));

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'main.js'
    ]
  },
  {
    files: ['main.ts', 'src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021
      }
    },
    plugins: {
      obsidianmd
    },
    rules: {
      'no-restricted-globals': ['error', ...BARE_WINDOW_GLOBALS],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'setTimeout', message: 'Use win.setTimeout on the owning window.' },
        { object: 'window', property: 'requestAnimationFrame', message: 'Use win.requestAnimationFrame on the owning window.' },
      ],
      'obsidianmd/commands/no-command-in-command-id': 'error',
      'obsidianmd/commands/no-command-in-command-name': 'error',
      'obsidianmd/commands/no-default-hotkeys': 'error',
      'obsidianmd/commands/no-plugin-id-in-command-id': 'error',
      'obsidianmd/commands/no-plugin-name-in-command-name': 'error',
      'obsidianmd/detach-leaves': 'error',
      'obsidianmd/editor-drop-paste': 'error',
      'obsidianmd/hardcoded-config-path': 'error',
      'obsidianmd/no-global-this': 'error',
      'obsidianmd/no-plugin-as-component': 'error',
      'obsidianmd/no-sample-code': 'error',
      'obsidianmd/no-tfile-tfolder-cast': 'error',
      'obsidianmd/no-unsupported-api': 'error',
      'obsidianmd/object-assign': 'error',
      'obsidianmd/platform': 'error',
      'obsidianmd/prefer-abstract-input-suggest': 'error',
      'obsidianmd/prefer-get-language': 'error',
      'obsidianmd/prefer-instanceof': 'error',
      'obsidianmd/prefer-window-timers': 'error',
      'obsidianmd/regex-lookbehind': 'error',
      'obsidianmd/validate-license': 'error',
      'obsidianmd/validate-manifest': 'error'
    }
  }
];
