/**
 * v88 — REGRAS DE PREFERÊNCIA E DE DADOS DA TELA INICIAL (regressão).
 *
 * 1. ATALHOS DA TELA INICIAL: só existem três (OFX, Despensa, Notificações
 *    do banco) e TODOS vêm DESLIGADOS na primeira abertura (o usuário liga
 *    em Ajustes e a escolha fica salva).
 * 2. DADOS: o toggle "Começar do zero a cada abertura" foi REMOVIDO — os dados
 *    nunca são apagados sozinhos ao abrir o app; só pelo botão "Começar do
 *    zero agora" (com confirmação).
 * 3. CATEGORIAS: o app não cria mais nenhuma categoria sozinho.
 */

import * as fs from 'fs';
import * as path from 'path';

const raiz = path.resolve(__dirname, '..', '..', '..');
const ler = (p: string) => fs.readFileSync(path.join(raiz, p), 'utf8');

const ajustes = ler('app/ajustes.tsx');
const home = ler('app/index.tsx');
const servicos = ler('src/services/index.ts');

describe('v88 — atalhos da tela inicial', () => {
  test('a tela inicial mostra SÓ três atalhos: OFX, Despensa e Notificações do banco', () => {
    expect(home).toContain('label="OFX"');
    expect(home).toContain('label="Despensa"');
    expect(home).toContain('label="Notificações do banco"');
    // saíram da tela inicial (continuam nos cards do Fluxo)
    expect(home).not.toContain('label="Orçamento"');
    expect(home).not.toContain('label="Poupança"');
    expect(home).not.toContain('label="Programação de Compra"');
  });

  test('todo atalho da tela inicial começa DESLIGADO (padrão false) e a escolha é salva', () => {
    // tela inicial
    expect(home).toContain('getBool(SETTING_KEYS.ofxNaHome, false)');
    expect(home).toContain('getBool(SETTING_KEYS.despensaNaHome, false)');
    expect(home).toContain('getBool(SETTING_KEYS.mensagensNaHome, false)');
    // Ajustes (mesmo padrão dos dois lados)
    expect(ajustes).toContain('getBool(SETTING_KEYS.ofxNaHome, false)');
    expect(ajustes).toContain('getBool(SETTING_KEYS.despensaNaHome, false)');
    // e o estado inicial da tela já nasce desligado (sem "piscar" ligado)
    expect(home).toContain('const [showOfx, setShowOfx] = React.useState(false);');
    expect(home).toContain('const [showDespensa, setShowDespensa] = React.useState(false);');
  });

  test('a seção Ações rápidas some quando nenhum dos três atalhos está ligado', () => {
    expect(home).toContain('const anyQuickAction = showOfx || showDespensa || showMensagens;');
  });
});

describe('v88 — Ajustes › Dados (sem limpeza automática)', () => {
  test('o toggle "Começar do zero a cada abertura" não existe mais', () => {
    // (o texto aparece só nos COMENTÁRIOS do código — o que interessa é o
    // rótulo visível do toggle)
    expect(ajustes).not.toContain('label="Começar do zero a cada abertura"');
    expect(ajustes).not.toContain('zerarAoAbrir');
    // o botão de limpeza manual continua
    expect(ajustes).toContain('Começar do zero agora');
    expect(ajustes).toContain('resetConfirmOpen');
  });

  test('o arranque do app NUNCA apaga os dados', () => {
    expect(servicos).not.toContain('zerar_ao_abrir');
    expect(servicos).not.toContain('resetUserData');
  });
});

describe('v88 — categorias: o app não cria nenhuma sozinho', () => {
  test('o texto do Ajustes diz que as categorias continuam (sem recriar padrão)', () => {
    expect(ajustes).toContain('As categorias que você cadastrou continuam');
    expect(ajustes).not.toContain('recoloca só as categorias padrão');
  });});
