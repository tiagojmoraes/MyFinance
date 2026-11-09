/** Configuração mínima do Jest (v9): garante que helpers de __tests__ não sejam
 *  tratados como suíte de teste. */
module.exports = {
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: ['src/services/**/*.ts'],
  coverageThreshold: {
    global: {
      statements: 60,
      branches: 50,
      functions: 65,
      lines: 65,
    },
  },
  coverageDirectory: '<rootDir>/.jest-coverage',
};
