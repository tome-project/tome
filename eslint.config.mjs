import tseslint from 'typescript-eslint';
export default tseslint.config({
  files: ['src/**/*.ts'],
  languageOptions: { parser: tseslint.parser },
  rules: { 'no-constant-condition': 'error', 'no-debugger': 'error', 'no-unreachable': 'error' },
});
