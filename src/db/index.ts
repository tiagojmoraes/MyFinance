/**
 * Fábrica de conexão. No app (runtime Expo) abre o SQLite local e roda migrações.
 * Núcleo de domínio (services/repos) NUNCA importa este arquivo — recebe DbDriver via construtor.
 */

import type { DbDriver } from './types';

let instance: DbDriver | null = null;
let opening: Promise<DbDriver> | null = null;

/** Abre (uma única vez) o driver do app com migrações aplicadas. */
export async function openAppDatabase(): Promise<DbDriver> {
  if (instance) return instance;
  if (opening) return opening;
  opening = (async () => {
    // Imports dinâmicos: evita puxar expo-sqlite para dentro dos testes Node
    const { ExpoSQLiteDriver } = require('./ExpoSQLiteDriver');
    const { runMigrations } = require('./migrations') as typeof import('./migrations');
    const driver = await ExpoSQLiteDriver.open('myfinance.db');
    await runMigrations(driver, { seedCategories: __DEV__ });
    instance = driver;
    return driver;
  })();
  return opening;
}

/** Injeta driver manualmente (usado por testes e bootstrap customizado). */
export function setDatabase(driver: DbDriver | null): void {
  instance = driver;
  opening = null;
}

export function getDatabase(): DbDriver {
  if (!instance) {
    throw new Error('Banco não inicializado: chame openAppDatabase() antes de usar os services.');
  }
  return instance;
}
