import globals from 'globals';

const rules = {
  'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'all' }],
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': 'error',
};

export default [
  { ignores: ['backend/**', 'data/**', 'dist/**', 'node_modules/**'] },
  { files: ['public/**/*.js'], languageOptions: { globals: globals.browser }, rules },
  { files: ['scripts/**/*.js', 'tests/**/*.js', 'eslint.config.js'], languageOptions: { globals: globals.node }, rules },
];
