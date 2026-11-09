/**
 * SCHEMA DEFINITIVO v7.0.0 — transcrição literal da "Especificação Definitiva de Implementação"
 * (Banco de Dados Schema Definitivo), com CHECKs e índices críticos.
 *
 * Convenções:
 *  - Valores monetários: INTEGER centavos.
 *  - DATE: 'YYYY-MM-DD' | DATETIME: ISO-8601 UTC.
 *  - ARQ-005: ON DELETE RESTRICT em FKs financeiras (histórico imutável, soft-delete VOIDED).
 *  - ARQ-003: UNIQUEs de idempotência (external_ref_id, fitid, access_key).
 */

export const SCHEMA_V1_SQL = /* sql */ `
-- ============================================================
-- TABELAS CORE
-- ============================================================

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('CHECKING','SAVINGS','CASH')),
  initial_balance_cents INTEGER NOT NULL DEFAULT 0,
  -- v20: data âncora do saldo inicial (NULL = vale "desde sempre", regra antiga).
  -- O valor é o saldo NO INÍCIO do dia informado; lançamentos anteriores a ele
  -- já estão DENTRO do saldo e não somam de novo.
  initial_balance_date TEXT,
  include_in_general_balance INTEGER NOT NULL DEFAULT 1,
  -- v54: amarração com o OFX do banco — código FEBRABAN (ex. 341 = Itaú) e
  -- últimos 4 dígitos da conta (ACCTID). Preenchidos no cadastro/importação.
  bank_code TEXT,
  bank_acct_last4 TEXT,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES categories(id),
  color_hex TEXT,
  -- v62: icon/direction (v7.1) + archived_at (v17) já no schema novo
  icon TEXT,
  direction TEXT NOT NULL DEFAULT 'BOTH',
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  last_four_digits TEXT,
  closing_day INTEGER NOT NULL CHECK (closing_day BETWEEN 1 AND 31),
  due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  linked_account_id TEXT REFERENCES accounts(id),
  archived_at TEXT,
  limit_cents INTEGER
);

CREATE TABLE IF NOT EXISTS recurrence_rules (
  id TEXT PRIMARY KEY NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('INCOME','EXPENSE')),
  amount_cents INTEGER NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('MONTHLY')),
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  start_date TEXT NOT NULL,
  end_date TEXT,
  account_id TEXT REFERENCES accounts(id),
  card_id TEXT REFERENCES cards(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  category_id TEXT REFERENCES categories(id),
  group_transaction_id TEXT REFERENCES transactions(id),
  invoice_month_offset INTEGER NOT NULL DEFAULT 0,
  -- v68 "Repetir": cadência da conta fixa — step_months (1=mensal, 2=bimestral,
  -- 3=trimestral, 6=semestral, 12=anual) ou step_days (7=semanal). NULL/1 = mensal.
  step_months INTEGER NOT NULL DEFAULT 1,
  step_days INTEGER
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('SIMPLE','CONSOLIDATED')),
  type TEXT NOT NULL CHECK (type IN ('INCOME','EXPENSE','TRANSFER')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  occurred_on TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  description TEXT NOT NULL,
  category_id TEXT REFERENCES categories(id),
  account_id TEXT REFERENCES accounts(id),
  transfer_account_id TEXT REFERENCES accounts(id),
  card_id TEXT REFERENCES cards(id),
  source_system TEXT NOT NULL CHECK (source_system IN ('MANUAL','OFX_BANK','OFX_CARD','NFCE','RECURRENCE','INSTALLMENT')),
  external_ref_id TEXT,
  recurrence_rule_id TEXT REFERENCES recurrence_rules(id),
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('PENDING','CONFIRMED','VOIDED')),
  parent_transaction_id TEXT REFERENCES transactions(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tx_source_ref
  ON transactions(source_system, external_ref_id) WHERE external_ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_account_date ON transactions(account_id, occurred_on);
CREATE INDEX IF NOT EXISTS idx_tx_card_date ON transactions(card_id, occurred_at);
-- ÍNDICE CRÍTICO da conciliação OFX batch (v7)
CREATE INDEX IF NOT EXISTS idx_trans_acc_amt_date ON transactions(account_id, amount_cents, occurred_on);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY NOT NULL,
  card_id TEXT NOT NULL REFERENCES cards(id),
  reference_month TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  due_date TEXT,
  total_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  credit_from_prev_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','PARTIALLY_PAID','PAID','OVERDUE'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_card_month ON invoices(card_id, reference_month);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id TEXT PRIMARY KEY NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  from_account_id TEXT REFERENCES accounts(id),
  amount_cents INTEGER NOT NULL,
  paid_on TEXT,
  method TEXT,
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED','VOIDED'))
);

CREATE TABLE IF NOT EXISTS installment_plans (
  id TEXT PRIMARY KEY NOT NULL,
  original_transaction_id TEXT UNIQUE REFERENCES transactions(id),
  total_installments INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('DIVIDE_TOTAL','FIXED_PER_MONTH')),
  total_cents INTEGER,
  fixed_amount_cents INTEGER,
  first_due_date TEXT NOT NULL,
  card_id TEXT REFERENCES cards(id),
  account_id TEXT REFERENCES accounts(id),
  group_transaction_id TEXT REFERENCES transactions(id),
  -- v68 "Repetir": cadência das parcelas (mesma semântica das contas fixas).
  step_months INTEGER NOT NULL DEFAULT 1,
  step_days INTEGER,
  CHECK ((card_id IS NOT NULL) + (account_id IS NOT NULL) = 1)
);

CREATE TABLE IF NOT EXISTS installments (
  id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL REFERENCES installment_plans(id) ON DELETE RESTRICT,
  sequence_number INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  invoice_id TEXT REFERENCES invoices(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','CANCELED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inst_plan_seq ON installments(plan_id, sequence_number);

CREATE TABLE IF NOT EXISTS financial_moves (
  id TEXT PRIMARY KEY NOT NULL,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE RESTRICT,
  installment_id TEXT REFERENCES installments(id) ON DELETE RESTRICT,
  invoice_payment_id TEXT REFERENCES invoice_payments(id) ON DELETE RESTRICT,
  account_id TEXT REFERENCES accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  effective_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED','VOIDED')),
  CHECK ((transaction_id IS NOT NULL) + (installment_id IS NOT NULL) + (invoice_payment_id IS NOT NULL) = 1)
);
CREATE INDEX IF NOT EXISTS idx_move_account_date_status ON financial_moves(account_id, effective_date, status);

CREATE TABLE IF NOT EXISTS invoice_items (
  id TEXT PRIMARY KEY NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  transaction_id TEXT REFERENCES transactions(id),
  installment_id TEXT REFERENCES installments(id),
  amount_cents INTEGER NOT NULL,
  CHECK ((transaction_id IS NOT NULL) + (installment_id IS NOT NULL) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_item_tx ON invoice_items(transaction_id) WHERE transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_item_inst ON invoice_items(installment_id) WHERE installment_id IS NOT NULL;

-- ============================================================
-- CATÁLOGO, DESPENSA, NFC-e, OFX
-- ============================================================

CREATE TABLE IF NOT EXISTS products_catalog (
  id TEXT PRIMARY KEY NOT NULL,
  ean TEXT UNIQUE,
  name TEXT NOT NULL,
  brand TEXT,
  category_id TEXT REFERENCES categories(id),
  base_unit TEXT CHECK (base_unit IN ('G','ML','UN')),
  unit_measure TEXT NOT NULL DEFAULT 'UN' CHECK (unit_measure IN ('UN','KG','G')),
  origin TEXT NOT NULL DEFAULT 'USER' CHECK (origin IN ('USER','NFCE')),
  -- v62: banco novo já nasce com pantry_policy (v57) — antes só existia via migração que nunca existiu
  pantry_policy TEXT NOT NULL DEFAULT 'ASK' CHECK (pantry_policy IN ('ALWAYS','ASK','NEVER'))
);

CREATE TABLE IF NOT EXISTS measurement_units (
  code TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_aliases (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL REFERENCES products_catalog(id),
  alias_text TEXT,
  store_name TEXT,
  store_product_code TEXT,
  -- v62: colunas v37 já no schema novo
  cnpj TEXT,
  match_count INTEGER NOT NULL DEFAULT 0,
  last_matched_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_alias_store_code
  ON product_aliases(store_name, store_product_code) WHERE store_product_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS pantry_stock (
  product_id TEXT PRIMARY KEY REFERENCES products_catalog(id),
  quantity_base INTEGER NOT NULL DEFAULT 0 CHECK (quantity_base >= 0),
  low_threshold_base INTEGER,
  last_movement_at TEXT
);

CREATE TABLE IF NOT EXISTS nfce_documents (
  access_key TEXT PRIMARY KEY NOT NULL CHECK (length(access_key) = 44),
  store_name TEXT,
  issued_at TEXT,
  amount_paid_cents INTEGER,
  gross_total_cents INTEGER,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  parse_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (parse_status IN ('PENDING','HEADER_ONLY','PARTIAL','COMPLETE','FAILED')),
  needs_review INTEGER NOT NULL DEFAULT 0,
  transaction_id TEXT REFERENCES transactions(id),
  -- v62: cnpj/source_url (v18) + created_at (v48) já no schema novo
  cnpj TEXT,
  source_url TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS nfce_items (
  id TEXT PRIMARY KEY NOT NULL,
  access_key TEXT NOT NULL REFERENCES nfce_documents(access_key),
  line_number INTEGER NOT NULL,
  description TEXT,
  ean_extracted TEXT,
  store_product_code TEXT,
  qty REAL,
  unit_original TEXT,
  total_cents INTEGER,
  product_id TEXT REFERENCES products_catalog(id),
  -- v62: log da decisão v37 já no schema novo
  match_type TEXT,
  match_score REAL,
  status TEXT NOT NULL DEFAULT 'PARSED' CHECK (status IN ('PARSED','ERROR','IGNORED')),
  stock_applied INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_nfce_item_line ON nfce_items(access_key, line_number);

CREATE TABLE IF NOT EXISTS pantry_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL REFERENCES products_catalog(id),
  delta_base INTEGER NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('PURCHASE_NFCE','PURCHASE_MANUAL','CONSUMPTION','WASTE','CORRECTION')),
  nfce_item_id TEXT REFERENCES nfce_items(id),
  transaction_id TEXT REFERENCES transactions(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_nfce_item
  ON pantry_ledger(nfce_item_id) WHERE nfce_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_product_time ON pantry_ledger(product_id, created_at);

CREATE TABLE IF NOT EXISTS ofx_imports (
  id TEXT PRIMARY KEY NOT NULL,
  content_hash_sha256 TEXT UNIQUE NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  imported_at TEXT NOT NULL,
  lines_processed INTEGER NOT NULL,
  errors_json TEXT
);

CREATE TABLE IF NOT EXISTS ofx_statement_lines (
  id TEXT PRIMARY KEY NOT NULL,
  import_id TEXT NOT NULL REFERENCES ofx_imports(id),
  fitid TEXT NOT NULL,
  posted_on TEXT,
  amount_cents INTEGER,
  memo TEXT,
  matched_transaction_id TEXT REFERENCES transactions(id),
  match_status TEXT NOT NULL DEFAULT 'UNPROCESSED' CHECK (match_status IN ('UNPROCESSED','MATCHED_AUTO','AMBIGUOUS','NEW_TX'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ofx_line_fitid ON ofx_statement_lines(import_id, fitid);

-- ============================================================
-- v69 — MENSAGENS BANCÁRIAS e LISTA DE DESEJOS
-- ============================================================

-- Notificações bancárias recebidas no aparelho (coladas pelo usuário — NÃO SMS).
-- NUNCA criam lançamento sozinhas: ficam na lista até o usuário escolher Lançar
-- (abre o Novo Lançamento preenchido) ou Deletar. v70: payment_method (forma de
-- pagamento citada — cartão débito/crédito) e card_final (final do cartão).
CREATE TABLE IF NOT EXISTS bank_messages (
  id TEXT PRIMARY KEY NOT NULL,
  sender TEXT,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  tx_date TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  kind TEXT NOT NULL CHECK (kind IN ('DEBIT','CREDIT')),
  description TEXT,
  payment_method TEXT CHECK (payment_method IN ('DEBITO','CREDITO')),
  card_final TEXT,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','LANCADO','DESCARTADA')),
  transaction_id TEXT REFERENCES transactions(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_messages_status ON bank_messages(status, received_at);

-- Itens da Lista de Desejos — classificação PRIORIDADE > NECESSÁRIO > DESEJO.
-- reserved_cents = somatório das reservas (dinheiro que JÁ SAIU do saldo
-- para a caixinha/poupança); 100% = "Pronto para comprar".
CREATE TABLE IF NOT EXISTS wishlist_items (
  id TEXT PRIMARY KEY NOT NULL,
  classificacao TEXT NOT NULL CHECK (classificacao IN ('PRIORIDADE','NECESSARIO','DESEJO')),
  description TEXT NOT NULL,
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  link TEXT,
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','BOUGHT')),
  bought_transaction_id TEXT REFERENCES transactions(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wishlist_status ON wishlist_items(status, classificacao);

-- Reservas de itens (transferência real origem → destino). O destino é a
-- caixinha "Reserva · Lista de Desejos" (conta FORA do saldo geral) ou a
-- CONTA POUPANÇA com is_poupanca = 1 (vira fatia separada na fechinha da conta).
CREATE TABLE IF NOT EXISTS wishlist_reserves (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES wishlist_items(id) ON DELETE CASCADE,
  from_account_id TEXT NOT NULL REFERENCES accounts(id),
  to_account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  is_poupanca INTEGER NOT NULL DEFAULT 0,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wishlist_reserves_item ON wishlist_reserves(item_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_reserves_dest ON wishlist_reserves(to_account_id);
`;

/** Categorias padrão (seed) — assumido como padrão seguro conforme changelog v7. */
export const SEED_CATEGORIES: Array<{ id: string; name: string; colorHex: string }> = [
  { id: 'cat-mercado', name: 'Mercado', colorHex: '#10b981' },
  { id: 'cat-alimentacao', name: 'Alimentação', colorHex: '#f59e0b' },
  { id: 'cat-transporte', name: 'Transporte', colorHex: '#3b82f6' },
  { id: 'cat-moradia', name: 'Moradia', colorHex: '#8b5cf6' },
  { id: 'cat-saude', name: 'Saúde', colorHex: '#ef4444' },
  { id: 'cat-educacao', name: 'Educação', colorHex: '#0ea5e9' },
  { id: 'cat-lazer', name: 'Lazer', colorHex: '#ec4899' },
  { id: 'cat-compras', name: 'Compras', colorHex: '#64748b' },
  { id: 'cat-servicos', name: 'Serviços', colorHex: '#14b8a6' },
  { id: 'cat-outros', name: 'Outros', colorHex: '#94a3b8' },
  { id: 'cat-salario', name: 'Salário', colorHex: '#22c55e' },
  { id: 'cat-rendimentos', name: 'Rendimentos', colorHex: '#84cc16' },
  { id: 'cat-receitas-outros', name: 'Outras receitas', colorHex: '#a3e635' },
];
