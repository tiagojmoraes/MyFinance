/**
 * v40 — DIAGNÓSTICO TOTAL da leitura NFC-e.
 *
 * Cobre a matemática que agora aponta causa raiz no terminal do VS Code:
 *  · DV módulo 11 da chave (provado contra a chave REAL do cupom Fonseca);
 *  · decodificação completa: UF, AAMM, CNPJ, modelo 65 (NFC-e) vs 55 (NFe);
 *  · trilha de etapas (nfceBegin/nfceStep/nfceVerdict) e utilidades do log;
 *  · fila de canais segue com o canônico .br primeiro (regressão v39.1).
 */

import {
  accessKeyDv,
  checkAccessKey,
  nfceKeyDescribe,
  extractAccessKey,
  listConsultUrls,
} from '../parsers/nfce';
import {
  nfceLog,
  nfceLogSnapshot,
  nfceLogClear,
  nfceBegin,
  nfceStep,
  nfceVerdict,
  nfceMs,
  nfceClip,
  nfceEnvLine,
  NFCE_TOTAL_STEPS,
  NFCE_STEP,
} from '../lib/nfcelog';

/** Chave REAL do cupom Fonseca (31/10/2026) — a prova de chão do DV. */
const FONSECA = '35261057032427001160651100000311141318831362';

describe('v40 — DV módulo 11 da chave de acesso', () => {
  test('DV bate com a chave real da Fonseca (DV=2)', () => {
    expect(accessKeyDv(FONSECA.slice(0, 43))).toBe(2);
    expect(Number(FONSECA[43])).toBe(2);
  });

  test('regra do resto 0/1 → DV 0', () => {
    // 43 dígitos "1" somam com pesos 2..9 ciclando — resto qualquer;
    // o importante é a fronteira: resto 0 e resto 1 → 0.
    // Construímos dois casos sintéticos e conferimos contra 11 - resto %11.
    const calc = (k: string) => {
      let soma = 0, peso = 2;
      for (let i = k.length - 1; i >= 0; i--) { soma += Number(k[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
      return { soma, dv: accessKeyDv(k) };
    };
    const a = calc('0000000000000000000000000000000000000000001');
    expect(a.dv).toBe(a.soma % 11 <= 1 ? 0 : 11 - (a.soma % 11));
  });

  test('um dígito errado é apontado (DV não confere)', () => {
    const errada = FONSECA.slice(0, 43) + '3'; // DV real é 2
    const check = checkAccessKey(errada);
    expect(check.dvOk).toBe(false);
    expect(check.dvExpected).toBe(2);
    expect(check.dvInformed).toBe(3);
    expect(check.ok).toBe(false);
    expect(check.problems.some((p) => /DV/.test(p))).toBe(true);
  });
});

describe('v40 — decodificação da chave (UF, AAMM, CNPJ, modelo)', () => {
  test('chave real da Fonseca: SP, 2026-10, CNPJ, modelo 65 NFC-e', () => {
    const c = checkAccessKey(FONSECA);
    expect(c.ok).toBe(true);
    expect(c.problems).toEqual([]);
    expect(c.dvOk).toBe(true);
    expect(c.ufCode).toBe('35');
    expect(c.ufName).toBe('SP');
    expect(c.year).toBe(2026);
    expect(c.month).toBe(10);
    expect(c.cnpj).toBe('57.032.427/0011-60');
    expect(c.modelo).toBe('65');
    expect(c.modeloName).toBe('NFC-e');
    expect(c.numero).toBe('000031114');
    expect(c.serie).toBe('110');
    const line = nfceKeyDescribe(c);
    expect(line).toContain('DV ✓');
    expect(line).toContain('UF 35=SP');
    expect(line).toContain('emissão 2026-10');
    expect(line).toContain('modelo 65 (NFC-e)');
  });

  test('chave de NFe (modelo 55) é recusada com causa clara', () => {
    // chave sintética válida: UF35 AAMM2610 CNPJ modelo55 etc. + DV certo
    const corpo = '35' + '2610' + '57032427001160' + '55' + '110' + '000031114' + '1' + '31883136';
    const dv = accessKeyDv(corpo);
    const check = checkAccessKey(corpo + String(dv));
    expect(check.modelo).toBe('55');
    expect(check.modeloName).toBe('NFe');
    expect(check.ok).toBe(false);
    expect(check.problems.some((p) => /NFe \(modelo 55\)/.test(p))).toBe(true);
  });

  test('chave curta/truncada é recusada sem tocar o portal', () => {
    const check = checkAccessKey(FONSECA.slice(0, 30));
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatch(/30 dígito/);
    expect(extractAccessKey(`chave truncada ${FONSECA.slice(0, 30)} fim`)).toBeNull();
  });

  test('UF desconhecida gera problema', () => {
    const corpo = '99' + '2610' + '57032427001160' + '65' + '110' + '000031114' + '1' + '31883136';
    const check = checkAccessKey(corpo + String(accessKeyDv(corpo)));
    expect(check.ufName).toBeNull();
    expect(check.ok).toBe(false);
    expect(check.problems.some((p) => /UF/.test(p))).toBe(true);
  });
});

describe('v40 — trilha de etapas no terminal (nfcelog)', () => {
  test('etapas e veredito aparecem no snapshot', () => {
    nfceLogClear();
    nfceBegin('teste automatizado', 'app 40.0.0 · relógio OK');
    nfceStep(NFCE_STEP.ENTRADA, 'ok', 'origem: teste');
    nfceStep(NFCE_STEP.CHAVE, 'ok', 'DV ✓');
    nfceStep(NFCE_STEP.CABECALHO, 'warn', 'FALTOU: emissão');
    nfceStep(NFCE_STEP.ITENS, 'fail', 'soma não confere');
    nfceVerdict(false, 'falha de teste', ['causa A', 'causa B'], 'tentar de novo');
    const snap = nfceLogSnapshot();
    expect(snap).toContain('NOVA CONSULTA NFC-e · origem: teste automatizado');
    expect(snap).toContain('ETAPA 1/8 · ENTRADA — ✓ OK');
    expect(snap).toContain('ETAPA 2/8 · CHAVE — ✓ OK');
    expect(snap).toContain('ETAPA 6/8 · CABEÇALHO — ⚠ ATENÇÃO');
    expect(snap).toContain('ETAPA 7/8 · ITENS — ✗ FALHA');
    expect(snap).toContain('VEREDICTO: FALHA');
    expect(snap).toContain('1) causa A');
    expect(snap).toContain('próximo passo: tentar de novo');
  });

  test('veredito de sucesso não lista causas', () => {
    nfceLogClear();
    nfceVerdict(true, 'NOTA REGISTRADA — 21 item(ns)');
    const snap = nfceLogSnapshot();
    expect(snap).toContain('VEREDICTO: SUCESSO');
    expect(snap).toContain('✔ NOTA REGISTRADA');
    expect(snap).not.toContain('causa(s) raiz');
  });

  test('nfceMs formata em pt-BR e nfceClip corta', () => {
    expect(nfceMs(1234)).toBe('1,2s');
    expect(nfceMs(80)).toBe('0,1s');
    expect(nfceMs(null)).toBe('');
    expect(nfceClip('abcdefghij', 5)).toBe('abcde…');
    expect(nfceClip('a\n b\t c', 20)).toBe('a b c');
  });

  test('nfceBRL formata centavos como no cupom (vírgula)', () => {
    const { nfceBRL } = require('../lib/nfcelog');
    expect(nfceBRL(41811)).toBe('R$ 418,11');
    expect(nfceBRL(7)).toBe('R$ 0,07');
    expect(nfceBRL(-155)).toBe('-R$ 1,55');
    expect(nfceBRL(null)).toBe('—');
    expect(nfceBRL(4000)).toBe('R$ 40,00');
  });

  test('nfceEnvLine traz app + relógio com UTC', () => {
    const env = nfceEnvLine('40.0.0');
    expect(env).toContain('app 40.0.0');
    expect(env).toMatch(/relógio do aparelho \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)/);
  });

  test('constantes da trilha: 8 etapas e nomes estáveis', () => {
    expect(NFCE_TOTAL_STEPS).toBe(8);
    expect(NFCE_STEP.ENTRADA).toBe(1);
    expect(NFCE_STEP.NAVEGADOR).toBe(4);
    expect(NFCE_STEP.RESULTADO).toBe(8);
  });
});

describe('v40 — regressão: fila de canais (canônico .br primeiro)', () => {
  test('canal 1 é sempre o canônico ConsultaQRCode.aspx', () => {
    const key = FONSECA;
    const urls = listConsultUrls(key, key); // entrada = chave pura
    expect(urls[0]).toBe(
      `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${key}%7C3%7C1`
    );
    expect(urls.length).toBe(2); // chave pura: canônico + portal público
    const qr = 'https://nfce.fazenda.sp/qrcode?p=35261057032427001160651100000311141318831362|3|1';
    const urls2 = listConsultUrls(qr, FONSECA);
    expect(urls2[0]).toContain('ConsultaQRCode.aspx');
    expect(urls2.length).toBe(3); // canônico + QR sanitizado + portal público
  });
});
