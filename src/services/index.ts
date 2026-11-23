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
import { ShoppingListService } from './ShoppingListService';
import { MonthLedgerService } from './MonthLedgerService';

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
  /** v69: Programação de Compra (classificações, reservas e metodologia). */
  wishlist: WishlistService;
  /** v104: LISTAS DE COMPRA SALVAS — múltiplas, com quantidade por item. */
  shoppingList: ShoppingListService;
  /** v16: livro-razão mensal encadeado (Saldo do dia, Orçamento, Programação
   *  de Compra, Poupança mensal e Fechamento do Mês passam a ser VIVOS e
   *  ENCADEADOS — o resultado de cada mês persiste e é a abertura do
   *  mês seguinte). */
  monthLedger: MonthLedgerService;
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
  // v69: mensagens bancárias e Programação de Compra (reserva usa o TransactionService
  // — transferência atômica — e o BalanceService para a sobra do mês).
  const bankMessages = new BankMessageService(db);
  const wishlist = new WishlistService(db, transactions, balance);
  // v104: o serviço da LISTA DE COMPRA não depende de orçamento/transferência
  // (só lê do banco e persiste listas); fica no grafo principal.
  const shoppingList = new ShoppingListService(db);
  // v16: livro-razão mensal (mantém a hierarquia encadeada em SQLite)
  const monthLedger = new MonthLedgerService(db, settings, balance, budgets, savings, wishlist);
  // v16: o Savings agora LÊ o livro-razão (computeMonthEndRemainderBefore-
  // Closing usa o ledger em vez de recalcular hierarquia).
  savings.hydrateLedger(monthLedger);
  return { db, balance, invoices, transactions, installments, recurrences, products, pantry, nfce, ofx, backup, categories, settings, budgets, savings, dashboard, search, bankMessages, wishlist, shoppingList, monthLedger };
}

let singleton: Services | null = null;

/**
 * v81 (DESEMPENHO + ROBUSTEZ): as 4 rotinas pesadas do arranque, agora numa
 * função própria — rodam em BACKGROUND, DEPOIS que o `ready` libera a UI.
 * Antes o boot esperava todas terminarem antes de abrir a 1ª tela; a
 * abertura ficava refém delas. Continuam idempotentes (ARQ-003) e o Fluxo as
 * reforça ao abrir (v50). Falha ISOLADA: antes as 4 compartilhavam um único
 * try/catch (a 1ª que falhasse pulava as demais); cada uma tem captura própria.
 */
export async function runStartupRoutines(
  svc: Pick<Services, 'recurrences' | 'transactions' | 'savings'>
): Promise<void> {
  const rotinas: Array<[string, () => Promise<unknown>]> = [
    // efetiva pendências vencidas (idempotente; guard v47 evita 2x no mesmo dia)
    ['recorrências vencidas', () => svc.recurrences.runDueRecurrences()],
    // v9: propaga contas fixas (Fixo) para os MESES FUTUROS do Fluxo —
    // nascem como previsão (Não Pago/Não Recebido, status PENDING)
    ['previsão das contas fixas', () => svc.recurrences.runForecast()],
    // v21 (bug 2): previsões à vista (data futura) vencidas viram efetivadas
    ['promoção de pendências', () => svc.transactions.promoteDuePendings()],
    // v42: gera/atualiza as PREVISÕES da poupança mensal (idempotente por plano/mês)
    ['previsão da poupança', () => svc.savings.generateForecast()],
  ];
  for (const [nome, rodar] of rotinas) {
    try {
      await rodar();
    } catch (err) {
      console.warn(`[services] arranque: ${nome} falhou (segue):`, err);
    }
  }
}

/** Singleton do app (lazy) — seguro de chamar em qualquer screen. */
export function getServices(): Services {
  if (singleton) return singleton;

  const deferred = new DeferredDriver();
  const core = buildServices(deferred);

  let readyResolve: () => void = () => {};
  let readyReject: (reason?: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  singleton = { ...core, db: deferred, ready };

  (async () => {
    // Imports dinâmicos: núcleo de domínio permanece livre de dependências Expo nos testes
    const { openAppDatabase } = require('../db') as typeof import('../db');
    const driver = await openAppDatabase();
    deferred.setReal(driver);
    // v86 (MELHORIA): o app NÃO apaga mais os dados a cada abertura.
    //  A limpeza do arranque (v83) existia para "ir testando do zero", mas
    //  custava caro (apagar e recriar tudo em toda abertura) e impedia o app
    //  de guardar qualquer histórico.
    // v88: a preferência "Começar do zero a cada abertura" foi REMOVIDA (o
    //  usuário achou confuso). Os dados NUNCA são apagados sozinhos ao abrir o
    //  app — quem quiser, usa o botão "Começar do zero agora" (Ajustes › Dados).
    //  O schema e a versão das migrações permanecem em qualquer caso.
    // v81 (DESEMPENHO): o `ready` libera a UI JÁ COM O BANCO PRONTO (abertura +
    // migrações + limpeza). As rotinas pesadas passam a rodar em background,
    // DEPOIS da 1ª tela — o app abre sem esperar por elas.
    readyResolve();
    void runStartupRoutines(singleton!);
  })().catch((err) => {
    console.error('[services] bootstrap error', err);
    readyReject(err);
  });

  return singleton;
}
