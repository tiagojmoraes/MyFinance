/**
 * Agregador de serviços — ARQ-001: classes Singleton centralizando os cálculos.
 * O app usa getServices(); os testes instanciam classes diretamente com o driver de teste.
 */

import type { DbDriver, RunResult, SqlValue } from '../db/types';
import { BalanceService } from './BalanceService';
import { TransactionService } from './TransactionService';
import { CardInvoiceService } from './CardInvoiceService';
import { InstallmentService } from './InstallmentService';
import { RecurrenceService } from './RecurrenceService';
import { ProductService } from './ProductService';
import { PantryService } from './PantryService';
import { NfceService } from './NfceService';
import { OfxService } from './OfxService';
import { BackupService } from './BackupService';
import { CategoryService } from './CategoryService';
import { SettingsService } from './SettingsService';
import { BudgetService } from './BudgetService';
import { SavingsService } from './SavingsService';
import { DashboardService } from './DashboardService';
import { SearchService } from './SearchService';
import { BankMessageService } from './BankMessageService';
import { WishlistService } from './WishlistService';

/** Driver proxy que delega ao driver real assim que o bootstrap terminar. */
class DeferredDriver implements DbDriver {
  private real: DbDriver | null = null;

  setReal(driver: DbDriver): void {
    this.real = driver;
  }

  private d(): DbDriver {
    if (!this.real) throw new Error('Banco de dados ainda inicializando — aguarde services.ready');
    return this.real;
  }

  execAsync(sql: string): Promise<void> {
    return this.d().execAsync(sql);
  }
  runAsync(sql: string, params?: SqlValue[]): Promise<RunResult> {
    return this.d().runAsync(sql, params);
  }
  getAllAsync<T>(sql: string, params?: SqlValue[]): Promise<T[]> {
    return this.d().getAllAsync<T>(sql, params);
  }
  getFirstAsync<T>(sql: string, params?: SqlValue[]): Promise<T | null> {
    return this.d().getFirstAsync<T>(sql, params);
  }
  transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    return this.d().transactionAsync(fn);
  }
  closeAsync(): Promise<void> {
    return this.d().closeAsync();
  }
}

export interface Services {
  db: DbDriver;
  balance: BalanceService;
  invoices: CardInvoiceService;
  transactions: TransactionService;
  installments: InstallmentService;
  recurrences: RecurrenceService;
  products: ProductService;
  pantry: PantryService;
  nfce: NfceService;
  ofx: OfxService;
  backup: BackupService;
  categories: CategoryService;
  settings: SettingsService;
  /** v42: orçamentos mensais por categoria. */
  budgets: BudgetService;
  /** v42: modo poupança (mensal / fechamento de mês). */
  savings: SavingsService;
  /** v46: série Previsto × Efetivado por dia (reusa o cache do BalanceService). */
  dashboard: DashboardService;
  /** v46: busca por descrição com paginação. */
  search: SearchService;
  /** v69: importação por mensagens bancárias (nunca cria lançamento sozinha). */
  bankMessages: BankMessageService;
  /** v69: Lista de Desejos (classificações, reservas e metodologia). */
  wishlist: WishlistService;
  ready: Promise<void>;
}

/** Monta o grafo de serviços sobre um driver (usado também em testes). */
export function buildServices(db: DbDriver): Omit<Services, 'ready'> {
  const balance = new BalanceService(db);
  const invoices = new CardInvoiceService(db);
  const transactions = new TransactionService(db, async (cardId, txId, amountCents, occurredAtIso, referenceMonth) => {
    await invoices.registerPurchase(cardId, txId, amountCents, occurredAtIso, referenceMonth);
  });
  const installments = new InstallmentService(db, invoices);
  transactions.onGroupDateChange = (gid, oldD, newD) => installments.followGroupDate(gid, oldD, newD);
  const recurrences = new RecurrenceService(db, invoices);
  const products = new ProductService(db);
  const pantry = new PantryService(db);
  const nfce = new NfceService(db, products, pantry);
  const ofx = new OfxService(db);
  const backup = new BackupService(db, {
    databasePath: '',
    backupsDir: '',
    vacuumInto: async () => {
      throw new Error('Backup de arquivo não configurado neste contexto');
    },
  });
  const categories = new CategoryService(db);
  const settings = new SettingsService(db);
  // v42: poupança usa o TransactionService (transferência atômica) e o BalanceService.
  const savings = new SavingsService(db, transactions, balance);
  const budgets = new BudgetService(db);
  const dashboard = new DashboardService(balance);
  const search = new SearchService(db);
  // v69: mensagens bancárias e Lista de Desejos (reserva usa o TransactionService
  // — transferência atômica — e o BalanceService para a sobra do mês).
  const bankMessages = new BankMessageService(db);
  const wishlist = new WishlistService(db, transactions, balance);
  return { db, balance, invoices, transactions, installments, recurrences, products, pantry, nfce, ofx, backup, categories, settings, budgets, savings, dashboard, search, bankMessages, wishlist };
}

let singleton: Services | null = null;

/** Singleton do app (lazy) — seguro de chamar em qualquer screen. */
export function getServices(): Services {
  if (singleton) return singleton;

  const deferred = new DeferredDriver();
  const core = buildServices(deferred);

  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  singleton = { ...core, db: deferred, ready };

  (async () => {
    // Imports dinâmicos: núcleo de domínio permanece livre de dependências Expo nos testes
    const { openAppDatabase } = require('../db') as typeof import('../db');
    const driver = await openAppDatabase();
    deferred.setReal(driver);
    // v8: dados mockados PERSISTIDOS no banco (regra geral de dados p/ testes) —
    // roda uma única vez, só quando o banco está vazio. NFC-e não é mockada.
    try {
      const { ensureMockData } = require('../db/seed') as typeof import('../db/seed');
      await ensureMockData(driver);
    } catch (err) {
      console.warn('[services] seed mock warn:', err);
    }
    // Recorrências em background (idempotente — ARQ-003)
    try {
      await singleton!.recurrences.runDueRecurrences();
      // v9: propaga contas fixas (Fixo) para os MESES FUTUROS do Fluxo —
      // nascem como previsão (Não Pago/Não Recebido, status PENDING).
      await singleton!.recurrences.runForecast();
      // v21 (bug 2): previsões à vista (data futura) vencidas viram efetivadas
      await singleton!.transactions.promoteDuePendings();
      // v42: gera/atualiza as PREVISÕES da poupança mensal (idempotente por plano/mês)
      await singleton!.savings.generateForecast();
    } catch (err) {
      console.warn('[services] recorrências warn:', err);
    }
    readyResolve();
  })().catch((err) => {
    console.error('[services] bootstrap error', err);
    readyResolve();
  });

  return singleton;
}
