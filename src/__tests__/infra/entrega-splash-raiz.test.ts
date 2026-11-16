/**
 * v70 — TESTES: notificações bancárias (NÃO SMS), OFX real robusto, Fechamento
 * Mensal com recálculo na hora, abertura do mês (retenção do Fechamento) e as
 * limpezas/melhorias de versão.
 *
 * 1. OFX OFICIAL (fixture anexada pelo usuário — Banco Inter, 71 lançamentos):
 *    parse completo, MEMO sujo (aspas/GUID), sem LEDGERBAL/AVAILBAL, formato BR
 *    negativo, mojibake/entidades, dedupe por FITID;
 * 2. IMPORTAÇÃO sem duplicar: hash idêntico aborta; arquivo atualizado (mesmos
 *    FITIDs + 1 novo) NÃO duplica; NFC-e/notificação já lançada casa por
 *    data+valor (MATCHED_AUTO), nunca vira linha nova;
 * 3. PARSER de notificações (exemplos REAIS do Inter): crédito nacional com
 *    cartão final, compra no débito, PIX recebido; genérico (sem "Tiago");
 * 4. ÁREA TEMPORÁRIA: ingest → NEW (nunca cria lançamento); Lançar + markLancado
 *    apaga o lançamento duplicado criado pelo próprio OFX (NEW_TX);
 * 5. FECHAMENTO MENSAL (1.2): confirmou estimativa → alterou valor → recalcula
 *    na hora; sem sobra → sai (nada retido);
 * 6. ABERTURA do mês (1.3): BalanceService devolve openingPrevisto (saldo
 *    carregado antes do dia 1) para o Fluxo zerar a retenção do fechamento;
 * 7. VERSÃO/LIMPEZA: version 70.0.0, splash configurado, raiz limpa (guias
 *    BATERIA-v*, OTIMIZACAO-v* movidos para docs/arquivo/), docs/CHANGELOG.md existe.
 */

import * as fs from 'fs';
import * as path from 'path';
import { makeCtx, seedAccount, type TestCtx } from '../helpers';
import { parseOfx, dedupeByFitid, parseOfxAmount, sanitizeOfxText } from '../../parsers/ofx';
import { OfxService } from '../../services/OfxService';
import {
  BankMessageService, parseBankMessage, parseValorTexto,
} from '../../services/BankMessageService';
import { SavingsService } from '../../services/SavingsService';
import { BalanceService } from '../../services/BalanceService';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'ofx-inter-oficial.ofx');
const OFX_REAL = fs.readFileSync(FIXTURE, 'utf8');

let ctx: TestCtx;

beforeEach(async () => {
  ctx = await makeCtx();
});
// ------------------------------------------------------ versão/limpeza ----

describe('entrega — splash configurado e raiz limpa (origem v70 · 7)', () => {
  const root = path.join(__dirname, '..', '..', '..');


  test('splash configurado com imagem (abertura nunca em branco)', () => {
    const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
    expect(appJson.expo.splash.image).toBeDefined();
    expect(fs.existsSync(path.join(root, appJson.expo.splash.image))).toBe(true);
  });

  test('raiz limpa: guias antigos removidos (CHANGELOG unificado) e COMECE-AQUI presente', () => {
    const raiz = fs.readdirSync(root).filter((f) => /^BATERIA-v|^OTIMIZACAO-v|^GARANTIA-|^NFCE-/.test(f));
    expect(raiz).toEqual([]); // nenhum guia antigo solto na raiz
    expect(fs.existsSync(path.join(root, 'docs', 'CHANGELOG.md'))).toBe(true);
    // v85+: os guias antigos por versão foram REMOVIDOS (o CHANGELOG é o
    // histórico único) — não existe mais a pasta docs/arquivo/.
    expect(fs.existsSync(path.join(root, 'docs', 'arquivo'))).toBe(false);
    // essenciais permanecem na raiz
    expect(fs.existsSync(path.join(root, 'COMECE-AQUI.md'))).toBe(true);
    // v85: guia renomeado sem cedilha — o nome antigo não volta
    expect(fs.existsSync(path.join(root, 'COMEÇAR-AQUI.md'))).toBe(false);
    // v80: guias unificados — INICIO-AQUI e BATERIA-COMO-RODAR viraram o COMECE-AQUI
    expect(fs.existsSync(path.join(root, 'INICIO-AQUI.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'BATERIA-COMO-RODAR.md'))).toBe(false);
  });

  test('migração v53: bank_messages com payment_method e card_final', async () => {
    const v = await ctx.db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(v!.user_version).toBeGreaterThanOrEqual(53);
    const cols = (await ctx.db.getAllAsync<{ name: string }>("PRAGMA table_info('bank_messages')")).map((c) => c.name);
    expect(cols).toContain('payment_method');
    expect(cols).toContain('card_final');
  });
});