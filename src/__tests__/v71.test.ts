/**
 * v71 — TESTES: NOTIFICAÇÕES DO BANCO SEM COPIAR/COLAR.
 *
 * 1. GRID CAPTURADO (lógica pura): ordenação da barra, parse de cada card
 *    (notificações REAIS do Banco Inter — crédito nacional com cartão final e
 *    compra no débito), flag lanccavel e filtro do que já está na lista;
 * 2. FLUXO DOS 02 BOTÕES (serviço):
 *    "Lançar" → ingest NEW → Novo Lançamento (nunca cria sozinho); tocar de
 *    novo não duplica; após lançar, o aviso "já foi lançada" (status LANCADO);
 *    "Excluir" (grid) é só do repositório da barra; DESCARTADA reaparece como
 *    linha nova se a notificação voltar ao grid;
 * 3. TELA (marcadores estáticos): botão "Colar notificação" e a caixa de
 *    colar SAIÍRAM; o texto "Compras sem NFC-e (...)" SAIU; a tela pede a
 *    PERMISSÃO ("Permitir acesso às notificações"), assina a chegada em tempo
 *    real e mostra o grid com Lançar/Excluir;
 * 4. MÓDULO NATIVO: manifesto com BIND_NOTIFICATION_LISTENER_SERVICE +
 *    NotificationListenerService (captura as que JÁ estão na barra e as que
 *    chegam), config do módulo local e versão 71.0.0.
 */

import * as fs from 'fs';
import * as path from 'path';
import { makeCtx, seedAccount, type TestCtx } from './helpers';
import {
  BankMessageService,
  type BankMessageStatus,
} from '../services/BankMessageService';
import {
  corpoCanonico,
  gridItem,
  ordenarCapturadas,
  separarCapturadas,
} from '../lib/bankNotificationGrid';
import type { CapturedBankNotification } from '../lib/bankNotifications';

const CREDITO_TIKTOK =
  'Olá Tiago. Você acaba de comprar R$ 126,24 em TikTok Shop. A compra foi no crédito nacional, com o cartão final 6830.';
const DEBITO_GYGABOM =
  'Olá Tiago, você acaba de comprar no débito SORVETERIA GYGABOM o valor de R$ 59,47.';
const PIX_RECEBIDO = 'Você recebeu um Pix de R$ 250,00 de MARIA SOUZA.';
const SEM_VALOR = 'Sua fatura está disponível no app do banco.';

const captura = (id: string, body: string, postTime: number, appName = 'Banco Inter'): CapturedBankNotification => ({
  id,
  appPackage: 'br.com.intermedium',
  appName,
  title: appName,
  body,
  postTime,
  count: 1,
});

let ctx: TestCtx;

beforeEach(async () => {
  ctx = await makeCtx();
});

// ---------------------------------------------------- grid (lógica pura) ----

describe('v71 · 1 — grid das notificações capturadas (lógica pura)', () => {
  test('card do crédito nacional: valor, SAÍDA, CARTÃO CRÉDITO, final 6830, TikTok Shop', () => {
    const item = gridItem(captura('n1', CREDITO_TIKTOK, 1000));
    expect(item.lanccavel).toBe(true);
    expect(item.parsed).not.toBeNull();
    expect(item.parsed!.amountCents).toBe(12624);
    // compra no crédito é DESPESA no cartão de crédito (dinheiro que SAI)
    expect(item.parsed!.kind).toBe('DEBIT');
    expect(item.parsed!.paymentMethod).toBe('CREDITO');
    expect(item.parsed!.cardFinal).toBe('6830');
    expect(item.parsed!.description).toBe('TikTok Shop');
    expect(item.appName).toBe('Banco Inter');
  });

  test('card da compra no débito: valor, SAÍDA, CARTÃO DÉBITO, SORVETERIA GYGABOM', () => {
    const item = gridItem(captura('n2', DEBITO_GYGABOM, 2000));
    expect(item.lanccavel).toBe(true);
    expect(item.parsed!.amountCents).toBe(5947);
    expect(item.parsed!.kind).toBe('DEBIT');
    expect(item.parsed!.paymentMethod).toBe('DEBITO');
    expect(item.parsed!.cardFinal).toBeNull();
    expect(item.parsed!.description).toBe('SORVETERIA GYGABOM');
  });

  test('card de PIX recebido: ENTRADA (+) com remetente em caixa alta', () => {
    const item = gridItem(captura('n3', PIX_RECEBIDO, 3000));
    expect(item.lanccavel).toBe(true);
    expect(item.parsed!.kind).toBe('CREDIT');
    expect(item.parsed!.amountCents).toBe(25000);
    expect(item.parsed!.description).toBe('MARIA SOUZA');
  });

  test('notificação sem valor reconhecido vira card "sem valor" — Lançar não preenche', () => {
    const item = gridItem(captura('n4', SEM_VALOR, 4000));
    expect(item.lanccavel).toBe(false);
    expect(item.parsed).toBeNull();
  });

  test('grid ordena da notificação MAIS RECENTE para a mais antiga', () => {
    const ordenadas = ordenarCapturadas([
      captura('a', CREDITO_TIKTOK, 1000),
      captura('b', DEBITO_GYGABOM, 3000),
      captura('c', PIX_RECEBIDO, 2000),
    ]);
    expect(ordenadas.map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });

  test('mensagem que JÁ está na lista/lançada SAI do grid (mesma mensagem nunca vira 2 cards)', () => {
    const { grid, jaNaLista } = separarCapturadas(
      [captura('n1', CREDITO_TIKTOK, 1000), captura('n2', DEBITO_GYGABOM, 2000)],
      [`  ${CREDITO_TIKTOK}  `] // body já gravado no banco, com espaços
    );
    expect(grid.map((i) => i.id)).toEqual(['n2']);
    expect(jaNaLista).toBe(1);
  });

  test('corpoCanonico normaliza espaços para o casamento grid × banco', () => {
    expect(corpoCanonico('  Olá Tiago  ')).toBe('Olá Tiago');
    expect(corpoCanonico('')).toBe('');
  });
});

// ----------------------------------------------- fluxo dos 02 botões ----

describe('v71 · 2 — botões do grid (Lançar / Excluir) no serviço', () => {
  let svc: BankMessageService;

  beforeEach(() => {
    svc = ctx.services.bankMessages;
  });

  test('"Lançar": notificação capturada entra como NEW e devolve o id do Novo Lançamento', async () => {
    const r = await svc.ingest('Banco Inter', CREDITO_TIKTOK);
    expect(r.inserted).toBe(true);
    expect(r.status).toBe<BankMessageStatus>('NEW');
    expect(r.id).not.toBeNull();
    const m = await svc.getById(r.id!);
    expect(m?.sender).toBe('Banco Inter');
    expect(m?.amount_cents).toBe(12624);
    expect(m?.payment_method).toBe('CREDITO');
    expect(m?.card_final).toBe('6830');
  });

  test('tocar "Lançar" de novo NÃO duplica — mesma notificação, mesmo id, ainda NEW', async () => {
    const r1 = await svc.ingest('Banco Inter', CREDITO_TIKTOK);
    const r2 = await svc.ingest('Banco Inter', CREDITO_TIKTOK);
    expect(r2.inserted).toBe(false);
    expect(r2.id).toBe(r1.id);
    expect(r2.status).toBe('NEW');
    expect(await svc.countPending()).toBe(1);
  });

  test('listActiveBodies traz NEW e LANCADO — o grid não repete o que já está na lista', async () => {
    const acc = await seedAccount(ctx.db);
    const r = await svc.ingest('Banco Inter', DEBITO_GYGABOM);
    expect(await svc.listActiveBodies()).toContain(DEBITO_GYGABOM);
    // usuário lança de verdade (a FK do registro pede lançamento real)
    const txRow = await ctx.services.transactions.createAccountExpense({
      description: 'SORVETERIA GYGABOM',
      amountCents: 5947,
      accountId: acc,
    });
    await svc.markLancado(r.id!, txRow.id, acc);
    // já lançada: continua "ativa" para o grid não mostrar de novo…
    expect(await svc.listActiveBodies()).toContain(DEBITO_GYGABOM);
    // …e o botão Lançar avisa em vez de criar outra
    const deNovo = await svc.ingest('Banco Inter', DEBITO_GYGABOM);
    expect(deNovo.inserted).toBe(false);
    expect(deNovo.id).toBe(r.id);
    expect(deNovo.status).toBe('LANCADO');
  });

  test('"Excluir" do grid é só da barra; notificação DESCARTADA no banco reaparece como NOVA', async () => {
    const r = await svc.ingest('Banco Inter', PIX_RECEBIDO);
    await svc.discard(r.id!);
    expect(await svc.listActiveBodies()).not.toContain(PIX_RECEBIDO);
    // a captura da barra continua lá — o usuário pode lançar depois: nova linha
    const deNovo = await svc.ingest('Banco Inter', PIX_RECEBIDO);
    expect(deNovo.inserted).toBe(true);
    expect(deNovo.id).not.toBe(r.id);
    expect(deNovo.status).toBe('NEW');
  });

  test('notificação sem valor não entra na lista (motivo claro para o card "sem valor")', async () => {
    const r = await svc.ingest('Banco Inter', SEM_VALOR);
    expect(r.inserted).toBe(false);
    expect(r.id).toBeNull();
    expect(r.status).toBeNull();
    expect(r.motivo).toContain('Não encontrei valor');
  });
});

// ------------------------------------------------- tela (marcadores) ----

describe('v71 · 3 — tela Notificações do banco: sem copiar/colar, com permissão e grid', () => {
  const raiz = path.join(__dirname, '..', '..');
  const tela = fs.readFileSync(path.join(raiz, 'app', 'mensagens.tsx'), 'utf8');

  test('botão "Colar notificação", caixa de colar e expo-clipboard SAIÍRAM', () => {
    // labels/elementos do fluxo antigo (v70) — nenhum pode restar na tela
    expect(tela).not.toContain('📋 Colar notificação');
    expect(tela).not.toContain('Adicionar à lista');
    expect(tela).not.toContain('TextField');
    expect(tela).not.toContain('expo-clipboard');
    expect(tela).not.toContain('Clipboard');
    expect(tela).not.toContain('getStringAsync');
    expect(tela).not.toContain('…ou cole o texto aqui');
  });

  test('texto "Compras sem NFC-e (...)" removido da tela (melhoria 2.1)', () => {
    expect(tela).not.toContain('Compras sem NFC-e');
    expect(tela).not.toContain('Shopee, online, assinatura');
  });

  test('a tela pede a AUTORIZAÇÃO e monta o grid com os 02 botões por notificação', () => {
    expect(tela).toContain('Permitir acesso às notificações');
    expect(tela).toContain('Notificações capturadas');
    expect(tela).toContain('Lançar');
    expect(tela).toContain('Excluir');
    // tempo real: quando chegar notificação do banco o grid atualiza sozinho
    expect(tela).toContain('subscribeBankNotificationsChanged');
    // grid alimentado pela barra do sistema com filtro do que já está na lista
    expect(tela).toContain('separarCapturadas');
    expect(tela).toContain('getCapturedBankNotifications');
    // nunca cria lançamento sozinho: Lançar abre o Novo Lançamento preenchido
    expect(tela).toContain("pathname: '/lancamento'");
    expect(tela).toContain('params: { msg: r.id }');
  });
});

// --------------------------------------------------- módulo nativo ----

describe('v71 · 4 — módulo nativo Android (captura da barra do sistema)', () => {
  const base = path.join(
    __dirname, '..', '..',
    'modules', 'bank-notifications'
  );

  test('config de módulo local aponta para BankNotificationsModule (autolink)', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(base, 'expo-module.config.json'), 'utf8')
    );
    expect(config.platforms).toContain('android');
    expect(config.android.modules).toContain('expo.modules.banknotifications.BankNotificationsModule');
  });

  test('manifesto declara o serviço com BIND_NOTIFICATION_LISTENER_SERVICE', () => {
    const manifest = fs.readFileSync(
      path.join(base, 'android', 'src', 'main', 'AndroidManifest.xml'), 'utf8'
    );
    expect(manifest).toContain('BankNotificationListenerService');
    expect(manifest).toContain('android.permission.BIND_NOTIFICATION_LISTENER_SERVICE');
    expect(manifest).toContain('android.service.notification.NotificationListenerService');
  });

  test('serviço captura as notificações JÁ na barra (onListenerConnected) e as que CHEGAM', () => {
    const servico = fs.readFileSync(
      path.join(
        base, 'android', 'src', 'main', 'java', 'expo', 'modules', 'banknotifications',
        'BankNotificationListenerService.kt'
      ),
      'utf8'
    );
    expect(servico).toContain('NotificationListenerService()');
    expect(servico).toContain('onListenerConnected');
    expect(servico).toContain('onNotificationPosted');
    expect(servico).toContain('activeNotifications');
    // filtro bancário + dedupe (mesma mensagem não repete no grid)
    expect(servico).toContain('isBankApp');
    expect(servico).toContain('br.com.intermedium');
    expect(servico).not.toContain('TODO');
  });

  test('versão do projeto: package.json e app.json em 71.0.0', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(pkg.version).toBe('71.0.0');
    const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'app.json'), 'utf8'));
    expect(appJson.expo.version).toBe('71.0.0');
  });
});
