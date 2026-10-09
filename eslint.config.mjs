import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'evidence/**', 'yomitan/**', 'site/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    ...eslintPluginReact.configs.flat.recommended,
    ...eslintPluginReact.configs.flat['jsx-runtime'],
    settings: { react: { version: 'detect' } },
    plugins: {
      react: eslintPluginReact,
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReact.configs.flat.recommended.rules,
      ...eslintPluginReact.configs.flat['jsx-runtime'].rules,
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      'react/prop-types': 'off'
    }
  },
  {
    // The overlay realm has the extension shim's `chrome` global installed by host/shim.js.
    files: ['ui/**/*.js'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' }
  },
  {
    files: ['host/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' }
  },
  {
    files: ['scripts/**/*.mjs', 'branding/**/*.mjs', 'vite.config.ts', 'vite.dev.config.ts', 'vite.demo.config.ts', 'vite.preview.config.ts', 'eslint.config.mjs'],
    languageOptions: { globals: { ...globals.node } }
  }
)
