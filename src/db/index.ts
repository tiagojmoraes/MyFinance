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
    await runMigrations(driver);
    instance = driver;
    return driver;
  })();
  try {
    return await opening;
  } catch (err) {
    // v87 (BUG MÉDIA): a promise REJEITADA ficava em cache — depois de uma
    // falha (banco corrompido, migration quebrada) o app nunca mais tentava
    // abrir o banco sem reiniciar. Agora a promessa é limpa e a próxima
    // chamada tenta de novo.
    opening = null;
    throw err;
  }
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
