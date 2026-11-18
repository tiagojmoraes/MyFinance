/**
 * v68 — BUGS do Fluxo + MELHORIAS de Ajustes/Cadastros + "Repetir" (pedido do usuário).
 *  Roda: npx jest src/__tests__/v68.test.ts
 *
 *  FLUXO (BUGS):
 *   1. "Orçado • Previsto • Gasto" ao expandir o Orçamento (Orçado = limite;
 *      Previsto = pendentes; Gasto = efetivados).
 *   2. Poupança expandida mostra o PLANO CADASTRADO: nome, modalidade, valor,
 *      guardado/falta.
 *   3. Saldo do dia Previsto/Efetivado INCORPORA Orçamento e Poupança
 *      (Fechamento do Mês: nada entra — o restante é da poupança; Mensal: o
 *      valor programado volta ao número) — sem o bloco "Orçamentos:".
 *  AJUSTES: grupos expansíveis (Preferencias/Backup/Dados/Sobre), toggles
 *      NFC-e/OFX/Despensa, seções removidas, "Restaurar Dados", SOBRE enxuto;
 *      Home: Ações rápidas só com alguma opção ativada.
 *  TELAS: subtítulos removidos; "+ Subcategoria" inline; Catálogo só
 *      visualização com edição em tela própria.
 *  LANÇAMENTO: "Repetir" (Semanal…Anual) para Fixo e Parcelado; categoria
 *      some quando a nota lida manda nas categorias; "Colar e consultar"
 *      branco no modal escuro.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeCtx, seedAccount, expectRejects } from '../helpers';
import { monthOf, todaySP, dayInMonth, monthAdd, addDays, lastDayNumberOf } from '../../lib/dates';
import { BackupService } from '../../services/BackupService';
import { BetterSQLiteDriver } from '../../db/BetterSQLiteDriver';
import { runMigrations } from '../../db/migrations';

const root = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const fluxoSrc = () => read('app', 'fluxo.tsx');
const ajustesSrc = () => read('app', 'ajustes.tsx');
const homeSrc = () => read('app', 'index.tsx');
const lancSrc = () => read('app', 'lancamento.tsx');

let ctx: Awaited<ReturnType<typeof makeCtx>> | null = null;
beforeEach(async () => {
  ctx = await makeCtx();
});

const curMonth = () => monthOf(todaySP());

// ═══════════════════════ 1 — Orçado • Previsto • Gasto ═══════════════════════

describe('v68 FLUXO 1 — Orçamento expandido: Orçado • Previsto • Gasto', () => {
  test('Previsto = pendentes da categoria; Gasto = efetivados; Orçado = limite', async () => {
    const { services, db } = await ctx!;
    const acc = await seedAccount(services.db, 'Conta Orc', 50_000);
    const cat = await services.categories.create({ name: 'Mercado V68', direction: 'DEBIT', icon: '🛒', parentId: null });
    await services.budgets.save(cat.id, 100_000); // Orçado R$ 100,00
    // PREVISTO — pendência determinística (à vista futura nasce PENDING; aqui força o estado)
    const pend = await services.transactions.createAccountExpense({
      description: 'Feira', amountCents: 20_000, accountId: acc, date: `${curMonth()}-02`, categoryId: cat.id,
    });
    await db.runAsync("UPDATE transactions SET status = 'PENDING' WHERE id = ?", [pend.id]);
    // GASTO — efetivado
    const paid = await services.transactions.createAccountExpense({
      description: 'Padaria', amountCents: 10_000, accountId: acc, date: `${curMonth()}-03`, categoryId: cat.id,
    });
    await services.transactions.setPaymentStatus(paid.id, true);

    const sum = await services.budgets.getMonthSummary(curMonth());
    expect(sum.items).toHaveLength(1);
    const it = sum.items[0];
    expect(it.amountCents).toBe(100_000); // Orçado
    expect(it.previstoCents).toBe(20_000); // Previsto (não efetivado)
    expect(it.efetivadoCents).toBe(10_000); // Gasto (efetivado)
    expect(it.spentCents).toBe(30_000); // comprometido (compatibilidade)
    expect(sum.previstoCents).toBe(20_000);
    expect(sum.efetivadoCents).toBe(10_000);
  });

  test('a tela mostra "Orçado • Gasto" por orçamento e no total (v94: sem Previsto)', () => {
    const src = fluxoSrc();
    // v94: o helper virou orcadoGastoLinha (sem o "Previsto"); a regra de % por
    // movimento continua (orçado + gasto = denominador).
    expect(src).toContain('orcadoGastoLinha(budgetSum.budgetedCents, budgetSum.efetivadoCents)');
    expect(src).toContain('orcadoGastoLinha(it.amountCents, it.efetivadoCents)');
    // o helper com "Previsto" saiu dos cards do Fluxo (mantém disponibilidade
    // para outros usos internos/testes).
    expect(src).not.toContain('orcadoPrevistoGastoLinha(');
    expect(src).not.toContain('previsto: budgetSum'); // sem campo separado de Previsto no rodapé
    // nada de "gastou" (vocabulário antigo)
    expect(src).not.toContain('gastou');
  });
});

// ═══════════════════════ 2 — Plano cadastrado na Poupança ═══════════════════════

describe('v68 FLUXO 2 — Poupança expandida mostra o plano cadastrado', () => {
  test('nome (conta destino), modalidade, valor, guardado/falta', async () => {
    const { services, db } = await ctx!;
    const origem = await seedAccount(services.db, 'Conta Origem', 100_000);
    // destino FORA do escopo (como uma caderneta de poupança à parte)
    const destinoId = `acc-dest-${Math.random().toString(36).slice(2, 8)}`;
    await db.runAsync(
      'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?,?,?,0)',
      [destinoId, 'Caderneta', 'SAVINGS', 0]
    );
    await services.savings.createMonthlyPlan({
      amountCents: 30_000, dayOfMonth: 1, fromAccountId: origem, toAccountId: destinoId,
    });
    // garante a previsão do MÊS VISTO (o default pula o mês quando o dia já passou)
    await services.savings.generateForecast(`${curMonth()}-01`);
    const ov = await services.savings.getMonthOverview(curMonth());
    expect(ov.plans).toHaveLength(1);
    const p = ov.plans[0];
    expect(p.name).toContain('Caderneta');
    expect(p.modalityLabel).toContain('Mensal');
    expect(p.amountCents).toBe(30_000);
    // transferência do dia 1 do mês — já efetivada → guardou tudo
    expect(p.guardadoCents).toBe(30_000);
    expect(p.faltaCents).toBe(0);
    // no mês SEGUINTE a previsão ainda está em aberto → falta guardar tudo
    const proximo = monthAdd(curMonth(), 1);
    const ovNext = await services.savings.getMonthOverview(proximo);
    const pn = ovNext.plans.find((x) => x.planId === p.planId);
    expect(pn?.guardadoCents).toBe(0);
    expect(pn?.faltaCents).toBe(30_000);
  });

  test('a tela mostra APENAS 2 informações consolidadas + botão Efetivar (v94)', () => {
    const src = fluxoSrc();
    // v94: card Poupança expandido mostra só:
    //   · "Poupança · Mensal" (soma das programações planejadas)
    //   · "Poupança · Fechamento" (saldo do fim do mês)
    //   · botão "Efetivar fechamento" (só Fechamento)
    //   · botão "Cadastrar / alterar poupança" (regras gerais)
    expect(src).toMatch(/Poupança · Mensal/);
    expect(src).toMatch(/Poupança · Fechamento/);
    expect(src).toContain('Efetivar fechamento');
    expect(src).toContain('Cadastrar / alterar poupança');
    // cabeçalho do card segue: "Guardado no mês X de Y"
    expect(src).toMatch(/Guardado no mês /);
    // Garantia contra regressão: nada do card-por-plano antigo pode voltar.
    expect(src).not.toContain('Guardado ${formatBRL(p.guardadoCents)} de ${formatBRL(meta)}');
    expect(src).not.toContain('Modalidade: ${p.modalityLabel}');
    expect(src).not.toContain('Falta transferir');
    expect(src).not.toContain('Já transferido p/ poupança');
    expect(src).not.toContain('Programado p/ poupança');
    // o link verde "Cadastrar / alterar (...)" saiu do LancamentoRow (regra geral)
    expect(src).not.toContain('onCadastrar=');
    expect(src).not.toContain('cadastrarLabel=');
  });
});

// ═══════════════════════ 3 — Saldo do dia com Orçamento + Poupança ═══════════════════════

describe('v68 FLUXO 3 — Saldo do dia Previsto/Efetivado incorpora Orçamento e Poupança', () => {
  test('Mensal (destino fora do escopo): o valor programado VOLTA ao saldo do dia', async () => {
    const { services, db } = await ctx!;
    const origem = await seedAccount(services.db, 'Conta Saldo', 100_000);
    const destinoId = `acc-dest-${Math.random().toString(36).slice(2, 8)}`;
    await db.runAsync(
      'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?,?,?,0)',
      [destinoId, 'Caderneta Saldo', 'SAVINGS', 0]
    );
    await services.savings.createMonthlyPlan({
      amountCents: 40_000, dayOfMonth: 1, fromAccountId: origem, toAccountId: destinoId,
    });
    // garante a previsão do MÊS VISTO (o default pula o mês quando o dia já passou)
    await services.savings.generateForecast(`${curMonth()}-01`);
    const adj = await services.savings.getMonthFluxAdjust(curMonth(), [origem]);
    const last = `${curMonth()}-${String(lastDayNumberOf(curMonth())).padStart(2, '0')}`;
    // dia 1 (já passado): a transferência EFETIVADA tirou R$ 40 do escopo — o
    // saldo do dia efetivado volta a tê-lo ("+ efetivado na Poupança")
    expect(adj.efetivado[last]).toBe(40_000);
    expect(adj.previsto[last]).toBe(0);
    // no mês seguinte a previsão é PENDING: o previsto do dia volta a tê-lo
    const proximo = monthAdd(curMonth(), 1);
    const adjNext = await services.savings.getMonthFluxAdjust(proximo, [origem]);
    const lastNext = `${proximo}-${String(lastDayNumberOf(proximo)).padStart(2, '0')}`;
    expect(adjNext.previsto[lastNext]).toBe(40_000);
    expect(adjNext.efetivado[lastNext]).toBe(0);
  });

  test('Mensal com destino DENTRO do escopo: ajuste zero (o dinheiro ficou no escopo)', async () => {
    const { services } = await ctx!;
    const a = await seedAccount(services.db, 'Conta A', 100_000);
    const b = await seedAccount(services.db, 'Conta B', 0);
    await services.savings.createMonthlyPlan({ amountCents: 25_000, dayOfMonth: 1, fromAccountId: a, toAccountId: b });
    const adj = await services.savings.getMonthFluxAdjust(curMonth(), [a, b]);
    const last = `${curMonth()}-${String(lastDayNumberOf(curMonth())).padStart(2, '0')}`;
    expect(adj.previsto[last]).toBe(0);
  });

  test('Fechamento do Mês sem estimativa confirmada: nada entra no saldo (o restante é da poupança)', async () => {
    const { services } = await ctx!;
    const a = await seedAccount(services.db, 'Conta Fech', 100_000);
    const b = await seedAccount(services.db, 'Destino Fech', 0);
    await services.savings.createClosingPlan({ fromAccountId: a, toAccountId: b });
    const adj = await services.savings.getMonthFluxAdjust(curMonth(), [a]);
    const last = `${curMonth()}-${String(lastDayNumberOf(curMonth())).padStart(2, '0')}`;
    expect(adj.previsto[last]).toBe(0);
    expect(adj.efetivado[last]).toBe(0);
  });

  test('Orçamento: compra pendente em conta do escopo NÃO dobra (ajuste 0)', async () => {
    const { services } = await ctx!;
    const acc = await seedAccount(services.db, 'Conta Alc', 50_000);
    const cat = await services.categories.create({ name: 'Alcada V68', direction: 'DEBIT', icon: '🛒', parentId: null });
    await services.budgets.save(cat.id, 80_000);
    await services.transactions.createAccountExpense({
      description: 'Mercado em conta', amountCents: 15_000, accountId: acc, date: `${curMonth()}-05`, categoryId: cat.id,
    });
    const adj = await services.budgets.getMonthFluxAdjust(curMonth(), [acc]);
    const last = `${curMonth()}-${String(lastDayNumberOf(curMonth())).padStart(2, '0')}`;
    expect(adj.previsto[last]).toBe(0); // o saldo base já tem o pendente
  });

  test('Orçamento: compromisso em conta FORA do escopo entra no saldo do dia', async () => {
    const { services, db } = await ctx!;
    const foraId = `acc-fora-${Math.random().toString(36).slice(2, 8)}`;
    await db.runAsync(
      'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?,?,?,0)',
      [foraId, 'Conta Fora', 'CHECKING', 0]
    );
    const cat = await services.categories.create({ name: 'Fora V68', direction: 'DEBIT', icon: '🛒', parentId: null });
    await services.budgets.save(cat.id, 80_000);
    // EFETIVADO — lançamento confirmado em conta fora do escopo
    await services.transactions.createAccountExpense({
      description: 'Despesa fora do escopo', amountCents: 12_000, accountId: foraId, date: `${curMonth()}-05`, categoryId: cat.id,
    });
    // PREVISTO — pendência determinística na mesma categoria
    const pend = await services.transactions.createAccountExpense({
      description: 'Previsão fora do escopo', amountCents: 7_000, accountId: foraId, date: `${curMonth()}-06`, categoryId: cat.id,
    });
    await db.runAsync("UPDATE transactions SET status = 'PENDING' WHERE id = ?", [pend.id]);

    const adj = await services.budgets.getMonthFluxAdjust(curMonth(), ['outra-conta']);
    const last = `${curMonth()}-${String(lastDayNumberOf(curMonth())).padStart(2, '0')}`;
    expect(adj.previsto[last]).toBe(-7_000); // previsto: só a pendência
    expect(adj.efetivado[last]).toBe(-12_000); // efetivado: só o confirmado
  });

  test('Orçamento: compra pendente no CARTÃO reserva desde a compra até a véspera da fatura', async () => {
    const { services } = await ctx!;
    const acc = await seedAccount(services.db, 'Conta Cartao V68', 50_000);
    const card = `card-${Math.random().toString(36).slice(2, 8)}`;
    await services.db.runAsync(
      'INSERT INTO cards (id, name, last_four_digits, closing_day, due_day, linked_account_id) VALUES (?,?,?,?,?,?)',
      [card, 'Cartão V68', '4321', 20, 28, acc]
    );
    const cat = await services.categories.create({ name: 'Cartao V68', direction: 'DEBIT', icon: '🛍️', parentId: null });
    await services.budgets.save(cat.id, 200_000);
    const compra = await services.transactions.createCardExpense({
      description: 'Compra no cartão', amountCents: 30_000, cardId: card, date: `${curMonth()}-02`, categoryId: cat.id,
    });
    // determinismo: a compra está PENDENTE (compra futura nasce assim)
    await services.db.runAsync("UPDATE transactions SET status = 'PENDING' WHERE id = ?", [compra.id]);
    const adj = await services.budgets.getMonthFluxAdjust(curMonth(), [acc]);
    const dia3 = `${curMonth()}-03`;
    const fim = `${curMonth()}-${String(lastDayNumberOf(curMonth())).padStart(2, '0')}`;
    // antecipa a reserva antes do vencimento da fatura…
    expect(adj.previsto[dia3]).toBeLessThanOrEqual(-30_000);
    // …e NÃO dobra depois que a fatura vence (o saldo base assume)
    expect(adj.previsto[fim]).toBe(0);
  });

  test('a tela NÃO tem o bloco "Orçamentos:" e soma os ajustes no número exibido', () => {
    const src = fluxoSrc();
    expect(src).not.toContain('Orçamentos: falta');
    expect(src).toContain('const dailyShown = React.useMemo(');
  });
});

// ═══════════════════════ AJUSTES — grupos expansíveis ═══════════════════════

describe('v68 AJUSTES — grupos expansíveis e conteúdo certo', () => {
  test('existe o grupo expansível (setinha para baixo) e os 4 grupos pedidos', () => {
    const src = ajustesSrc();
    expect(src).toContain('function Group(');
    // v69: SOBRE ficou sempre aberto, SEM seta (bloco próprio AboutBlock)
    expect(src).toContain('function AboutBlock(');
    expect(src).toMatch(/<Group\s+icon={ICONS\.ajustes}\s+title="Preferencias"/);
    expect(src).toMatch(/title="Backup"/);
    expect(src).toMatch(/title="Dados"/);
    expect(src).toContain('<AboutBlock>');
  });

  test('PREFERENCIAS tem os toggles com a grafia do usuário (v72: NFC-e saiu)', () => {
    const src = ajustesSrc();
    expect(src).toContain('label="Exibir Saldo do dia"');
    expect(src).toContain('label="Orçamento"');
    expect(src).toContain('label="Poupança"');
    expect(src).toContain('label="OFX"');
    expect(src).toContain('label="Despensa"');
    // v72: a opção NFC-e SAIU das preferências — ler nota é só pelo Novo Lançamento
    expect(src).not.toContain('label="NFC-e"');
    // descrições enxutas (não gigantes)
    // v88: Orçamento e Poupança ficaram SÓ no Fluxo (saíram da tela inicial)
    expect(src).toContain('Mostra o card de orçamento no Fluxo.');
    expect(src).toContain('Mostra o card de poupança no Fluxo.');
  });

  test('saiu: Leitura de notas (SEFAZ), Diagnóstico NFC-e (v40), Processar recorrências, Zerar tudo', () => {
    const src = ajustesSrc();
    expect(src).not.toContain('Leitura de notas (SEFAZ)');
    expect(src).not.toContain('Diagnóstico NFC-e');
    expect(src).not.toContain('Processar recorrências');
    expect(src).not.toContain('Zerar tudo');
  });

  test('BACKUP: "Criar Backup agora" (sem VACUUM INTO no rótulo) e "Restaurar Dados"', () => {
    const src = ajustesSrc();
    expect(src).toContain('label="Criar Backup agora"');
    expect(src).not.toContain('Criar backup agora (VACUUM INTO)');
    expect(src).toContain('label="Restaurar Dados"');
    expect(src).not.toContain('Restaurar de arquivo .db');
  });

  test('DADOS (limpeza) virou DADOS; SOBRE enxuto com "Versão do Schema"', () => {
    const src = ajustesSrc();
    expect(src).toContain('title="Dados"');
    expect(src).not.toContain('Dados (limpeza)');
    expect(src).toContain('k="Versão do Schema"');
    expect(src).not.toContain('Cadeia NFC-e');
    expect(src).not.toContain('Plataforma');
    expect(src).not.toContain('k="Valores"');
    expect(src).not.toContain('Histórico');
    expect(src).toContain('k="Versão" v={APP_VERSION}'); // só o número
  });
});

// ═══════════════════════ HOME — Ações rápidas condicionais ═══════════════════════

describe('v68 HOME — Ações rápidas só com alguma opção ativada', () => {
  test('a seção some quando nenhuma opção está ativada; toggles vêm do banco', () => {
    const src = homeSrc();
    expect(src).toContain('anyQuickAction');
    expect(src).toContain('{anyQuickAction ? (');
    // v72: o atalho NFC-e SAIU da tela inicial (entrada única = Novo Lançamento)
    expect(src).not.toContain('SETTING_KEYS.nfceNaHome');
    expect(src).not.toContain("label=\"NFC-e\"");
    expect(src).toContain('SETTING_KEYS.ofxNaHome');
    expect(src).toContain('SETTING_KEYS.despensaNaHome');
  });

  test('as chaves novas existem no SettingsService (persistidas no banco)', async () => {
    const { services } = await ctx!;
    await services.settings.setBool('nfce_na_home', false);
    expect(await services.settings.getBool('nfce_na_home', true)).toBe(false);
    expect(await services.settings.getBool('ofx_na_home', true)).toBe(true); // padrão ligado
  });
});

// ═══════════════════════ TELAS — subtítulos e cadastros ═══════════════════════

describe('v68 TELAS — subtítulo removido de baixo do título (8 telas)', () => {
  test('nenhuma das telas passa texto explicativo abaixo do título', () => {
    expect(read('app', 'cartoes.tsx')).not.toContain('Corte exato');
    expect(read('app', 'contas.tsx')).not.toContain('Saldo = inicial');
    expect(read('app', 'categorias.tsx')).not.toContain('Pictograma + Débito');
    expect(read('app', 'produtos.tsx')).not.toContain('Classifique 1 vez');
    expect(read('app', 'ofx.tsx')).not.toContain('Conciliação batch');
    expect(read('app', 'despensa.tsx')).not.toContain('Ledger append-only');
    expect(read('app', 'orcamento.tsx')).not.toContain('Cadastrar por categoria');
    expect(read('app', 'poupanca.tsx')).not.toContain('Cadastrar planos');
  });
});

describe('v68 CATEGORIAS — "+ Subcategoria" dentro do cartão', () => {
  test('a tela tem o botão inline e salva sem trocar de tela (campo + salvar ali mesmo)', () => {
    const src = read('app', 'categorias.tsx');
    expect(src).toContain('+ Subcategoria');
    expect(src).toContain('subOpenFor');
    expect(src).toContain('Nova subcategoria em');
    // não usa mais o formulário global para subcategoria
    expect(src).not.toContain('＋ Sub');
  });

  test('comportamento: subcategoria nasce com a direção da mãe e vínculo parent_id', async () => {
    const { services } = await ctx!;
    const pai = await services.categories.create({ name: 'Moradia V68', direction: 'DEBIT', icon: '🏠', parentId: null });
    const sub = await services.categories.create({ name: 'Aluguel V68', direction: 'DEBIT', icon: '🏠', parentId: pai.id });
    const row = await services.db.getFirstAsync<{ parent_id: string | null; direction: string }>(
      'SELECT parent_id, direction FROM categories WHERE id = ?', [sub.id]
    );
    expect(row?.parent_id).toBe(pai.id);
    expect(row?.direction).toBe('DEBIT');
  });
});

describe('v68 CATÁLOGO — lista só visualiza; edição em tela própria', () => {
  test('a lista NÃO tem −1/+1/Lixeira e abre a tela de edição pelo lápis/toque', () => {
    const src = read('app', 'produtos.tsx');
    expect(src).not.toContain('Consumir 1');
    expect(src).not.toContain('Adicionar 1');
    expect(src).not.toContain('do catálogo`}');
    expect(src).toContain('/produtos/${product.id}');
    expect(src).not.toContain('registerManualMovement'); // controles são da Despensa
  });

  test('a tela de edição própria existe (novo + editar) com excluir que só desvincula', () => {
    const edit = read('app', 'produtos', '[id].tsx');
    expect(edit).toContain("params.id === 'novo'");
    expect(edit).toContain('removeCatalogProduct');
    expect(edit).toContain('Salvar alterações');
    expect(edit).toContain('Cadastrar produto');
  });

  test('desempenho: filtro memoizado e linha memoizada no Catálogo', () => {
    const src = read('app', 'produtos.tsx');
    expect(src).toContain('React.useMemo(');
    expect(src).toContain('React.memo(function ProductCard');
  });
});

// ═══════════════════════ LANÇAMENTO — "Repetir" ═══════════════════════

describe('v68 LANÇAMENTO — seletor "Repetir" (Fixo e Parcelado)', () => {
  test('aparece só para Crédito/Débito + Fixo/Parcelado, logo abaixo do Tipo', () => {
    const src = lancSrc();
    // v69: virou BOTÕES (RepeatButtons) no esquema de cores débito/crédito
    expect(src).toContain('function RepeatButtons(');
    expect(src).toMatch(/<RepeatButtons\s+value={repeat}\s+onChange={\(v\) => setRepeat\(v\)}\s+tone={kind === 'INCOME' \? 'emerald' : 'rose'}\s*\/>/);
    expect(src).toMatch(/<RepeatButtons\s+value={l\.repeat}\s+onChange={\(v\) => updateLine\(l\.key, \{ repeat: v \}\)}\s+tone={l\.dir === 'CREDIT' \? 'emerald' : 'rose'}\s*\/>/);
    // as 6 cadências nos botões
    expect(src).toContain("{ value: 'SEMANAL', label: 'Semanal' }");
    expect(src).toContain("{ value: 'MENSAL', label: 'Mensal' }");
    expect(src).toContain("{ value: 'BIMESTRAL', label: 'Bimestral' }");
    expect(src).toContain("{ value: 'TRIMESTRAL', label: 'Trimestral' }");
    expect(src).toContain("{ value: 'SEMESTRAL', label: 'Semestral' }");
    expect(src).toContain("{ value: 'ANUAL', label: 'Anual' }");
  });

  test('Fixo SEMANAL gera ocorrências de 7 em 7 dias (ref por data)', async () => {
    const { services } = await ctx!;
    const acc = await seedAccount(services.db, 'Conta Semanal', 100_000);
    const start = `${curMonth()}-01`;
    await services.recurrences.createRule({
      description: 'Limpeza semanal', type: 'EXPENSE', amountCents: 5_000,
      dayOfMonth: 1, startDate: start, accountId: acc, stepDays: 7,
    });
    await services.recurrences.runDueRecurrences();
    const rows = await services.db.getAllAsync<{ occurred_on: string; external_ref_id: string }>(
      `SELECT occurred_on, external_ref_id FROM transactions
        WHERE description = 'Limpeza semanal' ORDER BY occurred_on`
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // todas caem em start + 7k e a ref é por DATA (pode haver mais de 1 no mês)
    for (const r of rows) {
      const diff = Math.round((Date.parse(r.occurred_on) - Date.parse(start)) / 86_400_000);
      expect(diff % 7).toBe(0);
      expect(r.external_ref_id).toContain(':D:');
    }
    // idempotência: rodar de novo não duplica
    await services.recurrences.runDueRecurrences();
    const again = await services.db.getAllAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM transactions WHERE description = 'Limpeza semanal'`
    );
    expect(again[0]?.n).toBe(rows.length);
  });

  test('Fixo TRIMESTRAL só nasce nos meses da cadência (inicio, +3, +6…)', async () => {
    const { services } = await ctx!;
    const acc = await seedAccount(services.db, 'Conta Trimestral', 100_000);
    await services.recurrences.createRule({
      description: 'IPVA trimestral', type: 'EXPENSE', amountCents: 9_000,
      dayOfMonth: 1, startDate: `${curMonth()}-01`, accountId: acc, stepMonths: 3,
    });
    await services.recurrences.runDueRecurrences();
    await services.recurrences.runForecast();
    const months = await services.db.getAllAsync<{ m: string }>(
      `SELECT DISTINCT substr(occurred_on, 1, 7) AS m FROM transactions
        WHERE description = 'IPVA trimestral' ORDER BY m`
    );
    const list = months.map((r) => r.m);
    expect(list).toContain(curMonth());
    expect(list).toContain(monthAdd(curMonth(), 3));
    expect(list).toContain(monthAdd(curMonth(), 6));
    expect(list).not.toContain(monthAdd(curMonth(), 1));
    expect(list).not.toContain(monthAdd(curMonth(), 2));
    expect(list).not.toContain(monthAdd(curMonth(), 4));
  });

  test('Parcelado BIMESTRAL: parcelas vencem de 2 em 2 meses', async () => {
    const { services } = await ctx!;
    const acc = await seedAccount(services.db, 'Conta Bimestral', 100_000);
    const first = `${curMonth()}-10`;
    const { planId } = await services.installments.createPlan({
      description: 'Curso bimestral', mode: 'FIXED_PER_MONTH', fixedAmountCents: 2_000,
      totalInstallments: 4, firstDueDate: first, accountId: acc, stepMonths: 2,
    });
    const rows = await services.db.getAllAsync<{ due_date: string }>(
      'SELECT due_date FROM installments WHERE plan_id = ? ORDER BY sequence_number', [planId]
    );
    expect(rows.map((r) => r.due_date)).toEqual([
      first, monthAdd(curMonth(), 2) + '-10', monthAdd(curMonth(), 4) + '-10', monthAdd(curMonth(), 6) + '-10',
    ]);
  });

  test('Parcelado SEMANAL: parcelas vencem de 7 em 7 dias', async () => {
    const { services } = await ctx!;
    const acc = await seedAccount(services.db, 'Conta Parcela Semanal', 100_000);
    const first = `${curMonth()}-05`;
    const { planId } = await services.installments.createPlan({
      description: 'Fiado semanal', mode: 'FIXED_PER_MONTH', fixedAmountCents: 1_000,
      totalInstallments: 3, firstDueDate: first, accountId: acc, stepDays: 7,
    });
    const rows = await services.db.getAllAsync<{ due_date: string }>(
      'SELECT due_date FROM installments WHERE plan_id = ? ORDER BY sequence_number', [planId]
    );
    expect(rows.map((r) => r.due_date)).toEqual([first, addDays(first, 7), addDays(first, 14)]);
  });

  test('Repetir não aparece para À vista nem em modo Alterar', () => {
    const src = lancSrc();
    // o bloco inteiro do Repetir está dentro de "isPlain && !isEdit" e só fora de À vista
    const idx = src.indexOf("<RepeatButtons value={repeat}");
    expect(idx).toBeGreaterThan(0);
    const plainIdx = src.indexOf('isPlain && !isEdit ? (');
    expect(plainIdx).toBeGreaterThan(0);
    expect(plainIdx).toBeLessThan(idx); // dentro do bloco do formulário simples
    const blockStart = src.indexOf("modality !== 'AVISTA' ? (", idx - 600);
    expect(blockStart).toBeGreaterThan(0);
    expect(blockStart).toBeLessThan(idx);
  });
});

// ═══════════════════════ LANÇAMENTO — QR e nota lida ═══════════════════════

describe('v68 LANÇAMENTO — QR "Colar e consultar" branco; categoria some com nota', () => {
  test('no modal escuro o botão de colar é BRANCO (contorno e texto)', () => {
    const manual = read('src', 'components', 'NfceManualInput.tsx');
    expect(manual).toContain("outlineClass={dark ? 'bg-transparent border border-white' : undefined}");
    expect(manual).toContain("outlineTextClass={dark ? 'text-white' : undefined}");
  });

  test('com nota lida (QR) o campo "Categoria (opcional)" do lançamento some', () => {
    const src = lancSrc();
    expect(src).toMatch(/\{!isTransfer && !isConsolidated && !nfceNote \? \(\s*<CategorySelect/);
    // e a nota segue com o card de itens (o resto da tela fica igual)
    expect(src).toContain('Itens da nota fiscal (NFC-e)');
  });
});

// ═══════════════════════ DESEMPENHO ═══════════════════════

describe('v68 DESEMPENHO — memoização dos cálculos e listas', () => {
  test('saldo do dia exibido é memoizado (não recalcula a cada digitação)', () => {
    const src = fluxoSrc();
    expect(src).toMatch(/const dailyShown = React\.useMemo\(/);
    // O saldo depende dos dados diários, dos ajustes e das reservas da
    // hierarquia mensal, incluindo o mês e os módulos ativos.
    expect(src).toMatch(/\}, \[[^\]]*dailyBal[^\]]*budAdj[^\]]*savAdj[^\]]*month[^\]]*\]\);/);
  });

  test('LancamentoRow é memoizado (React.memo)', () => {
    const src = read('src', 'components', 'LancamentoRow.tsx');
    expect(src).toContain('export const LancamentoRow = React.memo(LancamentoRowBase)');
  });

  test('Home memoiza os totais e as Ações rápidas', () => {
    const src = homeSrc();
    expect(src).toContain('const quickActions = React.useMemo(');
  });
});

// ═══════════════════════ MIGRAÇÃO ═══════════════════════

describe('v68 BACKUP — certificação de ponta a ponta (pedido do usuário)', () => {
  test('"Criar Backup agora" (VACUUM INTO) gera arquivo válido, legível e com os dados', async () => {
    const { db, services } = await ctx!;
    const acc = await seedAccount(services.db, 'Conta Backup V68', 77_000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkp-v68-'));
    const svc = new BackupService(db, {
      databasePath: path.join(dir, 'myfinance.db'),
      backupsDir: `${dir}/`,
      vacuumInto: (t) => (db as unknown as { vacuumInto: (p: string) => Promise<void> }).vacuumInto(t),
      listFiles: async (d) => fs.readdirSync(d),
    });
    const target = await svc.createBackup();
    expect(fs.existsSync(target)).toBe(true);
    expect((await svc.listBackups()).length).toBe(1);
    // o backup abre como banco SQLite íntegro e TEM os dados de origem
    const copy = BetterSQLiteDriver.file(target);
    const integ = await copy.getAllAsync<{ integrity_check: string }>('PRAGMA integrity_check');
    expect(integ[0]?.integrity_check).toBe('ok');
    const bal = await copy.getFirstAsync<{ initial: number }>('SELECT initial_balance_cents AS initial FROM accounts WHERE id = ?', [acc]);
    expect(bal?.initial).toBe(77_000);
    await copy.closeAsync();
  });
});

// ═══════════════════════ v87 — BACKUP: restauração segura ═══════════════════════

describe('v87 BACKUP — restauração segura (valida antes de trocar)', () => {
  /** Monta um BackupService com deps de arquivo de verdade (fs) + validação SQLite. */
  const montar = (dir: string, db: BetterSQLiteDriver) =>
    new BackupService(db, {
      databasePath: path.join(dir, 'myfinance.db'),
      backupsDir: `${dir}${path.sep}`,
      vacuumInto: async (t) => {
        await (db as unknown as { vacuumInto: (p: string) => Promise<void> }).vacuumInto(t);
      },
      listFiles: async (d) => fs.readdirSync(d),
      ensureDir: async (d) => {
        fs.mkdirSync(d, { recursive: true });
      },
      copyFile: async (from, to) => fs.copyFileSync(from.replace('file://', ''), to.replace('file://', '')),
      deleteFile: async (p) => fs.rmSync(p.replace('file://', ''), { force: true }),
      validateFile: async (p) => {
        const raw = p.replace('file://', '');
        const buf = fs.readFileSync(raw);
        if (buf.subarray(0, 16).toString('utf8') !== 'SQLite format 3\0') return false;
        const probe = BetterSQLiteDriver.file(raw);
        try {
          const check = await probe.getAllAsync<{ quick_check: string }>('PRAGMA quick_check');
          if (!check[0] || check[0].quick_check !== 'ok') return false;
          const tables = await probe.getAllAsync<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table'"
          );
          const names = tables.map((t) => t.name);
          return names.includes('transactions') && names.includes('accounts');
        } finally {
          await probe.closeAsync();
        }
      },
    });

  test('arquivo INVÁLIDO (PDF/texto) → banco atual INTACTO e erro amigável', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkp-v87-bad-'));
    const live = path.join(dir, 'myfinance.db');
    // banco "vivo" com um dado
    const db = BetterSQLiteDriver.file(live);
    await runMigrations(db);
    await db.runAsync(
      'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?,?,?,1)',
      ['acc-vivo', 'Conta Viva', 'CHECKING', 1234]
    );
    // o usuário escolhe um arquivo que NÃO é banco
    const ruim = path.join(dir, 'nota-fiscal.pdf');
    fs.writeFileSync(ruim, 'isto nao e um banco de dados');

    const svc = montar(dir, db);
    await expectRejects(() => svc.restoreFrom(ruim), /inválido/i);

    // o banco do usuário continua no lugar, íntegro e com o dado
    expect(fs.existsSync(live)).toBe(true);
    const checa = BetterSQLiteDriver.file(live);
    const bal = await checa.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM accounts WHERE id = ?',
      ['acc-vivo']
    );
    expect(bal?.n).toBe(1);
    await checa.closeAsync();
    await db.closeAsync();
  });

  test('arquivo VÁLIDO → banco trocado, snapshot de segurança criado e temporário apagado', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkp-v87-ok-'));
    // banco de origem (o backup escolhido pelo usuário)
    const origem = path.join(dir, 'origem.db');
    const src = BetterSQLiteDriver.file(origem);
    await runMigrations(src);
    await src.runAsync(
      'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?,?,?,1)',
      ['acc-restaurado', 'Conta Restaurada', 'CHECKING', 9999]
    );
    await src.closeAsync();

    // banco "live" do app
    const live = path.join(dir, 'myfinance.db');
    const db = BetterSQLiteDriver.file(live);
    await runMigrations(db);
    await db.runAsync(
      'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?,?,?,1)',
      ['acc-antigo', 'Conta Antiga', 'CHECKING', 1]
    );

    const svc = montar(dir, db);
    const out = await svc.restoreFrom(origem);
    expect(out.ok).toBe(true);
    expect(out.needsRestart).toBe(true);
    // snapshot do banco anterior existe (nada se perde)
    expect(out.safetyCopy && fs.existsSync(out.safetyCopy)).toBe(true);
    // o temporário não fica pendurado
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('restore-tmp-')).length).toBe(0);

    // o banco live agora é o restaurado
    const checa = BetterSQLiteDriver.file(live);
    const nomes = await checa.getAllAsync<{ id: string }>('SELECT id FROM accounts');
    expect(nomes.map((n) => n.id)).toContain('acc-restaurado');
    expect(nomes.map((n) => n.id)).not.toContain('acc-antigo');
    await checa.closeAsync();
    await db.closeAsync();
  });
});

describe('v68 MIGRAÇÃO — colunas da cadência existem (banco novo e regra v51)', () => {
  test('recurrence_rules e installment_plans têm step_months/step_days; user_version >= 51', async () => {
    const { db } = await ctx!;
    const ver = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(ver?.user_version ?? 0).toBeGreaterThanOrEqual(51);
    const rr = await db.getAllAsync<{ name: string }>("PRAGMA table_info('recurrence_rules')");
    const ip = await db.getAllAsync<{ name: string }>("PRAGMA table_info('installment_plans')");
    for (const col of ['step_months', 'step_days']) {
      expect(rr.map((c) => c.name)).toContain(col);
      expect(ip.map((c) => c.name)).toContain(col);
    }
  });

  test('regra SEM cadência (padrão v51) segue MENSAL — comportamento de sempre', async () => {
    const { services } = await ctx!;
    const acc = await seedAccount(services.db, 'Conta Mensal Padrao', 100_000);
    await services.recurrences.createRule({
      description: 'Fixa mensal clássica', type: 'EXPENSE', amountCents: 7_000,
      dayOfMonth: 1, startDate: `${curMonth()}-01`, accountId: acc,
    });
    await services.recurrences.runDueRecurrences();
    await services.recurrences.runForecast();
    const months = await services.db.getAllAsync<{ m: string }>(
      `SELECT DISTINCT substr(occurred_on, 1, 7) AS m FROM transactions
        WHERE description = 'Fixa mensal clássica' ORDER BY m`
    );
    const list = months.map((r) => r.m);
    expect(list).toContain(curMonth());
    expect(list).toContain(monthAdd(curMonth(), 1)); // mensal: todo mês
    expect(list).toContain(monthAdd(curMonth(), 2));
  });
});
