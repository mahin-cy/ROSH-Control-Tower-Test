import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', '**/generated/**']
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: {
      '@typescript-eslint': tseslint
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  },
  {
    files: ['backend/**/*.ts', 'shared/**/*.ts', 'tools/**/*.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
        // WHATWG globals available natively since Node 18/20, used by the
        // report-upload feature (storage.ts's per-call timeouts, and
        // bot-simulator.ts's HTTP upload) — matches engines.node >=22.
        AbortSignal: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        // Used by the OIDC login/callback routes to build/parse redirect
        // and authorization URLs (auth-oidc-route.ts, oidc-client.ts).
        URL: 'readonly'
      }
    }
  },
  {
    files: ['frontend/**/*.ts', 'frontend/**/*.tsx'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        // Used by the hand-rolled WHEP client (use-vehicle-video.ts) for
        // its connect-failure retry loop.
        setTimeout: 'readonly',
        clearTimeout: 'readonly'
      }
    }
  },
  prettierConfig
];
