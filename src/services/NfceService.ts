/**
 * NfceService — Ingestão NFC-e SP com ARQ-008 (Desacoplamento Financeiro-Fiscal):
 *
 *  1. Extrair Header (Chave, Estabelecimento, CNPJ, Total, Data)
 *  2. Criar Transação CONFIRMED imediatamente
 *  3. Tentar extrair Itens em background/retry (resolve produtos — hierarquia v7)
 *  4. Se falhar itens, manter transação válida. parse_status = PARTIAL/FAILED
 *
 * v18 (bug 6 — NFC-e ponta a ponta):
 *  - A URL do QR Code ESCANEADO é guardada (source_url) e usada nas tentativas
 *    de itens: a página oficial da SEFAZ-SP abre confiavelmente pelo link do QR
 *    (com assinatura); chave manual cai no portal público (e no legado, se preciso).
 *  - CNPJ do estabelecimento é extraído e guardado.
 *  - Fetch com User-Agent de navegador real, Accept-Language pt-BR, timeout de
 *    20 s e leitura por arrayBuffer com detecção de charset (UTF-8/ISO-8859-1).
 *  - Página rejeitada pelo WAF ("Request Rejected") é tratada como falha clara,
 *    não como HTML válido.
 *
 * v24 (SOLUÇÃO DEFINITIVA NFC-e — parte 1, app-side):
 *  - FIM DO "JÁ REGISTRADA ETERNO": documentos PENDING/FAILED gravados por
 *    tentativas antigas NÃO são mais tratados como "nota já registrada" —
 *    escanear a mesma nota REPROCESSA o documento (persistHeader virou UPSERT);
 *  - findRegisteredTransactionId: "registrada" só existe com transação real;
 *  - nenhuma rota de ingestão estoura UNIQUE(access_key) mais.
 *
 * v35 (PROCESSO DO APP QUE FUNCIONA — pedido explícito do usuário):
 *  - O print do app nativo que CONSEGUE ler a nota mostra o óbvio: quem faz o
 *    pedido é o PRÓPRIO CELULAR (pilha de rede real — TLS, cookies, JS). O
 *    `fetch` do JavaScript copia URL e cabeçalhos, mas "por dentro" é outro
 *    cliente — e é esse por-dentro que o firewall F5 julga (v34 falhou no
 *    teste real). 1º DEGRAU NOVO: MOTOR DO APARELHO (NfceWebEngine +
 *    NfceWebEngineView) — uma WebView OCULTA de 1×1 px, montada no layout
 *    raiz, com IDENTIDADE GENUÍNA (sem UA inventado), que executa o desafio
 *    do F5 nativamente e devolve o HTML renderizado. É a mesma classe de
 *    cliente que abre a nota quando o usuário toca no link. Os degraus
 *    v34 (fetch nativo Dalvik → navegador → serviço de leitura) continuam
 *    como reserva;
 *  - NfceWebFetch visível (plano B) também para de fingir ser Chrome (UA
 *    genuíno — o disfarce v23 nasceu de um diagnóstico viciado, anterior à
 *    correção de detecção da v25).
 *
 * v36 (JEITO QUE FUNCIONA, conferido com o JSON do usuário):
 *  - A análise Reqable do app que funciona provou: ele NÃO faz requisição
 *    nativa (OkHttp/Retrofit) nem abre o Chrome — ele usa a WEBVIEW DO
 *    ANDROID com User-Agent genuíno "Mozilla/5.0 (Linux; Android 13; moto
 *    g52 Build/…; wv) AppleWebKit/537.36 … Chrome/156.0.8078.47 Mobile
 *    Safari/537.36". A marca "; wv" e o motor Chrome real são justamente a
 *    identidade que o motor do aparelho (v35) usa — o 1º degrau está certo;
 *  - ORDEM DA CADEIA AJUSTADA: motor do aparelho → SERVIÇO DE LEITURA (se
 *    configurado) → fetch direto → navegador interno. O serviço subiu para
 *    o 2º lugar porque é o único degrau automático que o teste real nunca
 *    viu falhar; o fetch (recusado em TODAS as versões) não deve custar
 *    30–90 s antes do recurso que funciona;
 *  - FETCH DIRETO COM IDENTIDADE ÚNICA: a reserva de navegador (UA Mozilla)
 *    saiu do fetch — foi recusada em todos os testes reais (v30–v34) e o
 *    papel de "cliente de navegador" agora é do motor do aparelho, que faz
 *    isso DE VERDADE (engine, TLS, cookies e JS reais).
 *
 * v37 (TABELA DA VERDADE — pedido do usuário):
 *  - OBJETIVO: unificar o MESMO produto entre lojas DIFERENTES (mamão no
 *    Assaí código 123 = Carrefour 456 = Empório 789) e aprender com cada
 *    decisão para a PRÓXIMA nota já reconhecer o que foi classificado —
 *    "só pergunta dos novos";
 *  - A CHAVE DA VERDADE é o CNPJ (estável na nota), não o store_name
 *    (que varia: "SENDAS DISTRIBUIDORA" × "Assaí"): alias agora tem cnpj;
 *  - FUZZY POR TOKENS (productSimilarity): v59 — SÓ SUGERE o candidato na
 *    revisão (score >= 0.84), nunca unifica sozinho nem grava decisão;
 *    o usuário decide durante a NF (É esse / É outro / + Produto novo);
 *  - LOG DA DECISÃO em nfce_items (match_type/match_score): EAN | ALIAS
 *    (código) | FUZZY (nome+score) | MANUAL (você decidiu) | NEW;
 *  - RE-RESOLUÇÃO RETROATIVA: itens antigos sem produto são re-resolvidos
 *    quando a nota é reprocessada — o aprendizado alcança o passado;
 *  - GUARDA DE UNIDADE: item em KG ligado a produto em UN NÃO entra no
 *    estoque (contabilização por unidade separada — nunca mistura g com UN);
 *  - DECISÃO MANUAL VENCE: vincular/criar na revisão grava alias (CNPJ,
 *    código) e REAPONTA alias errado antigo. A verdade é corrigível.
 *
 * v34 (IDENTIDADE NATIVA — insight do Reqable do usuário):
 *  - Com o Reqable (no próprio celular) o usuário capturou um pedido REAL de
 *    um app nativo Android à SEFAZ-SP: User-Agent "Dalvik/2.1.0 (Linux; U;
 *    Android 13; moto g52 ...)". Essa é a assinatura dos apps nativos — a
 *    classe de cliente do próprio celular que o firewall F5 possivelmente
 *    aceita (o navegador embutido e o fetch com UA de navegador já foram
 *    recusados na v32, até no WiFi residencial).
 *  - A leitura direta tenta ANTES a identidade nativa, com cabeçalhos mínimos
 *    estilo Java/HttpURLConnection (enfeite de navegador entregaria o
 *    disfarce); a identidade de navegador fica como reserva. Se o portal
 *    aceitar o app nativo, a nota entra DE GRAÇA — sem serviço de leitura
 *    e sem navegador interno.
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { spDateOfIso, nowIso, noonUtcIsoOf } from '../lib/dates';
import { nfceLog, nfceHtmlSummary, nfceStep, nfceMs, nfceBRL, nfceClip, NFCE_STEP } from '../lib/nfcelog';
import {
  extractAccessKey,
  listConsultUrls,
  parseNfceHeader,
  parseNfceItems,
  convertToBaseUnit,
  isFirewallRejectionPage,
  looksLikeNfcePage,
  type NfceHeader,
} from '../parsers/nfce';
import { nfceWebEngine, WEBENGINE_TIMEOUT_MS } from './NfceWebEngine';
import { NfceDocumentRepo, NfceItemRepo } from '../repos/misc';
import type { NfceDocumentRow, NfceItemRow } from '../repos/misc';
import { TransactionRepo } from '../repos/finance';
import type { TransactionRow } from '../repos/finance';
import { ProductService, productUnitMeasureFromNfce } from './ProductService';
import { PantryService } from './PantryService';
import { fetchNoteViaReader, isReaderConfigured, type NfceReaderConfig } from '../lib/nfceReader';
import { SETTING_KEYS } from './SettingsService';

/**
 * v34/v36 — IDENTIDADE NATIVA do aparelho (capturada pelo usuário com o
 * Reqable): é o User-Agent que apps Android NATIVOS (HttpURLConnection)
 * enviam. v36: é a ÚNICA identidade do fetch direto — a reserva de navegador
 * (Mozilla) foi recusada em todos os testes reais e saiu da cadeia.
 */
export const NATIVE_UA =
  'Dalvik/2.1.0 (Linux; U; Android 13; moto g52 Build/T2SRS33.72-22-4-11)';
const FETCH_TIMEOUT_MS = 20_000;

/**
 * v30: espera aleatória ENTRE candidatos de URL (rate-limit do portal SEFAZ —
 * acesso em rajada é padrão de robô e o firewall bloqueia). Exportado para os
 * testes zerarem (suite não pode esperar segundos reais entre mocks).
 */
export const SEFAZ_RETRY_DELAY = { minMs: 2000, maxMs: 5000 };
const sefazRetryDelayMs = (): number =>
  SEFAZ_RETRY_DELAY.minMs + Math.floor(Math.random() * (SEFAZ_RETRY_DELAY.maxMs - SEFAZ_RETRY_DELAY.minMs + 1));

/**
 * v41 — ITEM PRONTO PARA O FORMULÁRIO (QR no Novo Lançamento):
 * o que o prepareFromHtml devolve para a tela montar o card "Itens da nota".
 * canApplyStock = produto vinculado + conversão de unidade possível + guarda de
 * dimensão ok (mesma regra do estoque automático). needsReview segue a regra
 * "só pergunta dos novos" (novo produto ou fuzzy abaixo do automático).
 */
export interface NfcePreparedItem {
  id: string;
  lineNumber: number;
  description: string | null;
  qty: number | null;
  unitOriginal: string | null;
  totalCents: number | null;
  productId: string | null;
  productName: string | null;
  matchType: string | null;
  matchScore: number | null;
  status: string;
  stockApplied: number;
  canApplyStock: boolean;
  needsReview: boolean;
  unitClash: boolean;
}

export class NfceService {
  private documents: NfceDocumentRepo;
  private items: NfceItemRepo;
  private transactions: TransactionRepo;

  constructor(
    private db: DbDriver,
    private productService: ProductService,
    private pantryService: PantryService
  ) {
    this.documents = new NfceDocumentRepo(db);
    this.items = new NfceItemRepo(db);
    this.transactions = new TransactionRepo(db);
  }

  /**
   * Passo 1+2 do ARQ-008: lê header e cria a transação imediatamente.
   * Idempotente por access_key (ARQ-003).
   *
   * v18: tenta as URLs em ordem (QR escaneado → portal público → legado);
   * guarda a URL que funcionou; CNPJ e estabelecimento entram no documento.
   * v19: este caminho de FETCH DIRETO virou FALLBACK — a página da SEFAZ-SP
   * fica atrás de verificação de navegador (F5/BIG-IP, desafio JavaScript +
   * cookies TS*), que fetch puro não resolve. O caminho principal agora é
   * ingestFromHtml(), alimentado pelo navegador interno (react-native-webview).
   */
  async ingestFromQrOrKey(input: string): Promise<{ accessKey: string; created: boolean; transactionId: string | null; needsAmount?: boolean }> {
    const accessKey = extractAccessKey(input);
    if (!accessKey) {
      throw new Error(
        'Não foi possível extrair a chave de 44 dígitos — escaneie o QR Code da nota ou cole a URL completa da SEFAZ'
      );
    }

    const existing = await this.documents.getById(accessKey);
    // v24: documento podre (PENDING/FAILED, sem transação) NÃO é "já registrada"
    // — segue o fluxo e o persistHeader atualiza o registro existente.
    const registeredId = await this.findRegisteredTransactionId(accessKey);
    if (registeredId) {
      return { accessKey, created: false, transactionId: registeredId };
    }

    const { html, url } = await this.fetchNote(input);

    if (!html) {
      // Sem página: registra documento PENDING (sem transação) para retry posterior
      // v24: se já existe registro podre, ATUALIZA em vez de estourar UNIQUE.
      if (existing) {
        await this.documents.updateHeader(accessKey, {
          parse_status: 'PENDING',
          ...(input.includes('http') ? { source_url: input.trim() } : {}),
        });
      } else {
        await this.documents.insert({
          access_key: accessKey,
          store_name: null,
          cnpj: null,
          issued_at: null,
          amount_paid_cents: null,
          gross_total_cents: null,
          discount_cents: 0,
          parse_status: 'PENDING',
          needs_review: 0,
          transaction_id: null,
          source_url: input.includes('http') ? input.trim() : null,
        });
      }
      return { accessKey, created: false, transactionId: null };
    }

    return this.persistHeader(accessKey, parseNfceHeader(html, accessKey), url);
  }

  /**
   * v35 — CAMINHO 1: MOTOR DO APARELHO (WebView oculta, identidade genuína).
   * Mesmo contrato dos demais degraus: null quando indisponível ou sem
   * sucesso — aí a cadeia segue (fetch Dalvik/navegador → serviço de leitura
   * → WebView interno). Sem componente montado (ex.: testes), o
   * degrau é pulado em milissegundos.
   */
  async ingestViaWebEngine(input: string): Promise<({
    accessKey: string;
    created: boolean;
    transactionId: string | null;
    needsAmount?: boolean;
    html: string;
  }) | null> {
    const accessKey = extractAccessKey(input);
    if (!accessKey) return null;
    if (!nfceWebEngine.hasDriver()) {
      nfceLog('serviço: motor do aparelho NÃO montado (WebView ausente) — pulando degrau');
      return null;
    }
    const registeredId = await this.findRegisteredTransactionId(accessKey);
    if (registeredId) {
      nfceLog('serviço: motor do aparelho — nota já registrada com transação real');
      return { accessKey, created: false, transactionId: registeredId, html: '' };
    }
    const candidates = listConsultUrls(input, accessKey);
    nfceLog(`serviço: MOTOR DO APARELHO (identidade genuína do celular) — ${candidates.length} canal(is) na fila`);
    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i];
      nfceLog(`serviço: motor do aparelho canal ${i + 1}/${candidates.length}: ${url}`);
      const res = await nfceWebEngine.read(url, WEBENGINE_TIMEOUT_MS);
      if (!res) {
        nfceLog(`serviço: motor do aparelho canal ${i + 1} → sem página (erro/tempo)`);
        continue;
      }
      if (isFirewallRejectionPage(res.html)) {
        nfceLog(`serviço: motor do aparelho canal ${i + 1} → REJEIÇÃO do firewall (${nfceHtmlSummary(res.html)})`);
        continue;
      }
      if (!looksLikeNfcePage(res.html)) {
        nfceLog(`serviço: motor do aparelho canal ${i + 1} → página não reconhecida (${nfceHtmlSummary(res.html)})`);
        continue;
      }
      nfceLog(`serviço: motor do aparelho CONSEGUIU a página via ${res.url}`);
      const out = await this.ingestFromHtml(accessKey, res.html, res.url);
      return { ...out, html: res.html };
    }
    nfceLog('serviço: motor do aparelho não conseguiu em nenhum canal — seguindo a cadeia');
    return null;
  }

  /**
   * v24: "nota já registrada" de verdade — existe documento COM transação e
   * sem status podre (PENDING/FAILED). Documento velho quebrado NÃO trava o
   * reescaneamento: a nota volta a ser processada normalmente.
   */
  /** v26: HTML da última captura desta nota (para diagnóstico/compartilhar). */
  async getCapturedHtml(accessKey: string): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = ?',
      [`nfce_html_${accessKey}`]
    );
    return row?.value ?? null;
  }

  async findRegisteredTransactionId(accessKey: string): Promise<string | null> {
    const doc = await this.documents.getById(accessKey);
    if (!doc || !doc.transaction_id) return null;
    if (doc.parse_status === 'PENDING' || doc.parse_status === 'FAILED') return null;
    return doc.transaction_id;
  }

  /**
   * v32/v33 — leitura automática SEM abrir tela. v36 — CADEIA FINAL:
   *  1º MOTOR DO APARELHO (WebView genuína — o processo do app que funciona);
   *  2º SERVIÇO DE LEITURA na nuvem (se configurado em Ajustes — o único
   *     degrau automático que o teste real do usuário nunca viu falhar;
   *     subiu para cá na v36 para não esperar o fetch falhar antes);
   *  3º FETCH DIRETO com a identidade Dalvik (2 canais, reserva gratuita);
   *  4º WebView interno (NfceWebFetch — consulta sem tela intermediária
   *     quando aqui devolve null). Devolve o resultado JÁ REGISTRADO e o HTML usado
   *     (para itens); null só se TODOS os degraus falharem.
   */
  async ingestByDirectFetch(input: string): Promise<({
    accessKey: string;
    created: boolean;
    transactionId: string | null;
    needsAmount?: boolean;
    html: string;
  }) | null> {
    const accessKey = extractAccessKey(input);
    if (!accessKey) {
      throw new Error(
        'Não foi possível extrair a chave de 44 dígitos — escaneie o QR Code da nota ou cole a URL completa da SEFAZ'
      );
    }
    const registeredId = await this.findRegisteredTransactionId(accessKey);
    if (registeredId) {
      nfceLog('serviço: leitura direta — nota já registrada com transação real');
      return { accessKey, created: false, transactionId: registeredId, html: '' };
    }
    // v35/v36 — 1º DEGRAU: MOTOR DO APARELHO (o mesmo processo do app que
    // funciona — WebView genuína, provado pelo JSON do usuário). Se conseguir,
    // NENHUM fetch é feito e nada queima a reputação do cliente.
    const viaEngine = await this.ingestViaWebEngine(input);
    if (viaEngine) return viaEngine;
    // v36 — 2º DEGRAU: SERVIÇO DE LEITURA (antes do fetch: não faz sentido
    // queimar 30–90 s com o fetch que o firewall sempre recusou antes de
    // tentar o único recurso automático que o teste real nunca viu falhar).
    const viaReader = await this.ingestViaReader(input);
    if (viaReader) return viaReader;
    // 3º DEGRAU: fetch direto (identidade Dalvik, 2 canais — reserva grátis).
    nfceLog('serviço: LEITURA DIRETA (sem navegador) — p=chave|3|1 completo → portal público');
    const { html, url } = await this.fetchNote(input);
    if (!html) {
      nfceLog('serviço: motor, serviço e fetch direto não conseguiram → o app abre o navegador interno (plano B)');
      return null;
    }
    nfceLog(`serviço: leitura direta CONSEGUIU a página via ${url}`);
    const res = await this.ingestFromHtml(accessKey, html, url);
    return { ...res, html };
  }

  /**
   * v33 — CAMINHO 2: SERVIÇO DE LEITURA (o "ajudante na nuvem"). O app pede a
   * página a um serviço profissional (ScrapingBee/ScraperAPI, configurado em
   * Ajustes > Leitura de notas), que busca com navegador completo + frota de
   * proxies — a receita que o firewall da SEFAZ-SP aceita (a mesma que a IA de
   * chat usou para ler a nota do usuário, e que o PowerShell provou pelo lado
   * do IP limpo). A manutenção do acesso é problema DO SERVIÇO: se o portal
   * apertar o firewall, o APK não precisa de versão nova.
   * Retorna null quando não configurado ou sem sucesso — a tela segue ao plano B.
   */
  async ingestViaReader(input: string): Promise<({
    accessKey: string;
    created: boolean;
    transactionId: string | null;
    needsAmount?: boolean;
    html: string;
  }) | null> {
    const cfg = await this.getReaderConfig();
    if (!cfg) {
      nfceLog('serviço: serviço de leitura NÃO configurado (Ajustes > Leitura de notas) — pulando degrau');
      return null;
    }
    const accessKey = extractAccessKey(input);
    if (!accessKey) return null;
    const registeredId = await this.findRegisteredTransactionId(accessKey);
    if (registeredId) {
      nfceLog('serviço: serviço de leitura — nota já registrada com transação real');
      return { accessKey, created: false, transactionId: registeredId, html: '' };
    }
    const targetUrl = listConsultUrls(input, accessKey)[0];
    nfceLog(`serviço: SERVIÇO DE LEITURA (${cfg.provider}) — buscando: ${targetUrl}`);
    const out = await fetchNoteViaReader(cfg, targetUrl);
    for (const line of out.attempts) nfceLog(`serviço:   leitura ${line}`);
    if (!out.html) {
      nfceLog('serviço: serviço de leitura NÃO conseguiu a página');
      return null;
    }
    nfceLog(`serviço: serviço de leitura CONSEGUIU a página (${nfceHtmlSummary(out.html)})`);
    const res = await this.ingestFromHtml(accessKey, out.html, targetUrl);
    return { ...res, html: out.html };
  }

  /** v33: configuração do serviço de leitura guardada em Ajustes (app_settings).
   *  Nula quando o provedor é 'none' ou a chave está vazia (comportamento v32). */
  private async getReaderConfig(): Promise<NfceReaderConfig | null> {
    const provider = await this.db.getFirstAsync<{ value: string | null }>(
      'SELECT value FROM app_settings WHERE key = ?',
      [SETTING_KEYS.nfceReaderProvider]
    );
    const apiKey = await this.db.getFirstAsync<{ value: string | null }>(
      'SELECT value FROM app_settings WHERE key = ?',
      [SETTING_KEYS.nfceReaderApiKey]
    );
    const cfg: NfceReaderConfig = {
      provider: (provider?.value ?? 'none') as NfceReaderConfig['provider'],
      apiKey: apiKey?.value ?? '',
    };
    return isReaderConfigured(cfg) ? cfg : null;
  }

  /**
   * v19 — CAMINHO 3: leitura pelo NAVEGADOR INTERNO (plano B): o
   * HTML vem do NfceWebFetch (react-native-webview), que abre a página oficial
   * da SEFAZ-SP, resolve a verificação do navegador (desafio JS do F5) e devolve
   * o DOM renderizado. Mesmo contrato de retorno do ingestFromQrOrKey.
   * v24 (solução definitiva — parte 1): documento existente porém SEM
   * transação (PENDING/FAILED de tentativas antigas) é ATUALIZADO com o HTML
   * novo — nunca mais resposta "já estava registrada" para uma nota que o
   * app nunca conseguiu ler de verdade.
   */
  async ingestFromHtml(
    accessKey: string,
    html: string,
    sourceUrl: string | null
  ): Promise<{ accessKey: string; created: boolean; transactionId: string | null; needsAmount?: boolean }> {
    // v31: o que chegou do navegador e o que o parser leu — tudo no terminal
    nfceLog(`serviço: HTML recebido do navegador (${nfceHtmlSummary(html)})`);
    const header = parseNfceHeader(html, accessKey);
    // v40: ETAPA 6 — CABEÇALHO campo a campo (o que veio e o que faltou)
    const missing: string[] = [];
    if (!header.storeName) missing.push('loja');
    if (!header.cnpj) missing.push('CNPJ');
    if (!header.issuedAt) missing.push('emissão');
    if (header.amountPaidCents == null && header.grossTotalCents == null) missing.push('valor');
    const headerVals =
      `loja=${header.storeName ? nfceClip(header.storeName, 50) : 'NÃO ACHOU'} · CNPJ=${header.cnpj ?? 'NÃO ACHOU'} · ` +
      `emissão=${header.issuedAt ?? 'NÃO ACHOU'} · ` +
      `total=${nfceBRL(header.amountPaidCents)}` +
      `${header.grossTotalCents != null ? ` (produtos ${nfceBRL(header.grossTotalCents)})` : ''}`;
    if (missing.length === 0) {
      nfceStep(NFCE_STEP.CABECALHO, 'ok', headerVals);
    } else if (missing.length < 4) {
      nfceStep(NFCE_STEP.CABECALHO, 'warn', `${headerVals} · FALTOU: ${missing.join(', ')}`);
    } else {
      nfceStep(NFCE_STEP.CABECALHO, 'fail', `nada extraído do HTML (${nfceHtmlSummary(html)}) — a página provavelmente não é a nota`);
    }
    const registeredId = await this.findRegisteredTransactionId(accessKey);
    if (registeredId) {
      nfceLog('serviço: nota JÁ registrada com transação real — nada a fazer');
      return { accessKey, created: false, transactionId: registeredId };
    }
    return this.persistHeader(accessKey, header, sourceUrl);
  }

  /**
   * Persiste header + transação CONSOLIDATED (usado pelos dois caminhos de ingestão).
   * v24: UPSERT — documento que já existe (mesmo PENDING/FAILED de tentativa
   * antiga) é ATUALIZADO com o header novo; inexistente é inserido. Nenhuma
   * rota deste método trava o reescaneamento de nota sem transação real.
   */
  private async persistHeader(
    accessKey: string,
    header: NfceHeader,
    sourceUrl: string | null
  ): Promise<{ accessKey: string; created: boolean; transactionId: string | null; needsAmount?: boolean }> {
    const amountCents = header.amountPaidCents ?? header.grossTotalCents;
    const existing = await this.documents.getById(accessKey);
    const headerFields = {
      store_name: header.storeName,
      cnpj: header.cnpj,
      issued_at: header.issuedAt,
      amount_paid_cents: header.amountPaidCents,
      gross_total_cents: header.grossTotalCents,
      discount_cents: header.discountCents,
      source_url: sourceUrl,
    };

    // Sem valor legível NÃO há transação (CHECK amount_cents > 0 no schema).
    if (!amountCents || amountCents <= 0) {
      // v40: valor não lido é a causa nº 1 de "não criou lançamento" — ETAPA 8 ATENÇÃO
      nfceStep(NFCE_STEP.RESULTADO, 'warn', 'cabeçalho SEM valor legível → nenhum lançamento criado (documento HEADER_ONLY, revisão manual)');
      if (existing) {
        await this.documents.updateHeader(accessKey, {
          ...headerFields,
          parse_status: 'HEADER_ONLY',
          needs_review: 1,
        });
      } else {
        await this.documents.insert({
          access_key: accessKey,
          ...headerFields,
          parse_status: 'HEADER_ONLY',
          needs_review: 1,
          transaction_id: null,
        });
      }
      return { accessKey, created: false, transactionId: existing?.transaction_id ?? null, needsAmount: true };
    }

    // Transação CONSOLIDATED CONFIRMED imediatamente (mesmo sem itens — ARQ-008)
    const occurredOn = header.issuedAt ? spDateOfIso(header.issuedAt) : nowIso().slice(0, 10);
    // Idempotência UNIQUE(source_system, external_ref_id): a mesma chave nunca
    // gera duas transações — mesmo com documento podre/ausente (v24).
    const again = await this.transactions.findByExternalRef('NFCE', accessKey);
    if (again) {
      // v40: idempotência — transação já existia por outra tentativa
      nfceStep(NFCE_STEP.RESULTADO, 'ok', `transação já existia para esta chave (id=${again.id.slice(0, 8)}…), nada duplicado`);
      if (existing) {
        await this.documents.updateHeader(accessKey, {
          ...headerFields,
          parse_status: 'HEADER_ONLY',
          needs_review: 0,
          transaction_id: again.id,
        });
      } else {
        await this.documents.insert({
          access_key: accessKey,
          ...headerFields,
          parse_status: 'HEADER_ONLY',
          needs_review: 0,
          transaction_id: again.id,
        });
      }
      return { accessKey, created: false, transactionId: again.id };
    }

    const txId = genId();
    const tx: TransactionRow = {
      id: txId,
      kind: 'CONSOLIDATED',
      type: 'EXPENSE',
      amount_cents: amountCents ?? 0,
      occurred_on: occurredOn,
      occurred_at: header.issuedAt ?? noonUtcIsoOf(occurredOn),
      description: `NFC-e ${header.storeName ?? 'loja desconhecida'}`,
      category_id: null,
      account_id: null,
      transfer_account_id: null,
      card_id: null,
      source_system: 'NFCE',
      external_ref_id: accessKey, // idempotência UNIQUE(source_system, external_ref_id)
      recurrence_rule_id: null,
      status: 'CONFIRMED',
    };
    await this.db.transactionAsync(async () => {
      await this.transactions.insert(tx);
      if (existing) {
        await this.documents.updateHeader(accessKey, {
          ...headerFields,
          parse_status: 'HEADER_ONLY',
          needs_review: 0,
          transaction_id: txId,
        });
      } else {
        await this.documents.insert({
          access_key: accessKey,
          ...headerFields,
          parse_status: 'HEADER_ONLY',
          needs_review: 0,
          transaction_id: txId,
        });
      }
    });

    // v40: resultado final da ingestão do cabeçalho — ETAPA 8 OK
    nfceStep(NFCE_STEP.RESULTADO, 'ok', `LANÇAMENTO CRIADO de ${nfceBRL(amountCents)} em ${occurredOn} (${header.storeName ? nfceClip(header.storeName, 50) : 'loja desconhecida'})`);
    return { accessKey, created: true, transactionId: txId };
  }

  /**
   * Passo 3 do ARQ-008 (roda em background): extrai itens, resolve produtos
   * (hierarquia v7) e aplica estoque nos matches confiáveis (EAN/ALIAS).
   * v18: usa a URL guardada do documento (QR escaneado) e os fallbacks.
   * v19: aceita o HTML PRONTO do navegador interno (htmlOverride) — nesse caso
   * não há fetch nenhum; sem override, mantém o fetch de fallback.
   */
  async processItems(accessKey: string, htmlOverride?: string): Promise<{ items: number; appliedToStock: number; needsReview: number }> {
    const doc = await this.documents.getById(accessKey);
    if (!doc) {
      // v40: documento ausente é causa raiz — aparece como FALHA antes de lançar exceção
      nfceStep(NFCE_STEP.ITENS, 'fail', `documento NFC-e não encontrado para a chave ${accessKey.slice(0, 8)}…`);
      throw new Error('Documento NFC-e não encontrado');
    }

    let html: string | null = htmlOverride ?? null;
    let url: string | null = doc.source_url ?? null;
    if (!html && nfceWebEngine.hasDriver()) {
      // v35: reprocessamento de itens também começa pelo MOTOR DO APARELHO
      // (mesmo 1º degrau da ingestão — o HTML volta renderizado e com itens).
      const engineCandidates = listConsultUrls(doc.source_url ?? accessKey, accessKey);
      nfceLog(`serviço: ITENS — motor do aparelho disponível, tentando ${engineCandidates.length} canal(is) antes do fetch`);
      for (const candidate of engineCandidates) {
        const res = await nfceWebEngine.read(candidate, WEBENGINE_TIMEOUT_MS);
        if (res && !isFirewallRejectionPage(res.html) && looksLikeNfcePage(res.html)) {
          html = res.html;
          url = res.url;
          break;
        }
      }
      if (html) nfceLog(`serviço: ITENS — motor do aparelho conseguiu a página via ${url}`);
    }
    if (!html) {
      // v36: serviço de leitura ANTES do fetch (mesma ordem da ingestão) —
      // é o degrau com maior taxa de sucesso conhecida.
      const cfg = await this.getReaderConfig();
      if (cfg && doc.source_url) {
        const out = await fetchNoteViaReader(cfg, doc.source_url);
        for (const line of out.attempts) nfceLog(`serviço:   itens ${line}`);
        if (out.html) {
          html = out.html;
          url = doc.source_url;
        }
      }
    }
    if (!html) {
      const fetched = await this.fetchNote(doc.source_url ?? '');
      html = fetched.html;
      url = fetched.url ?? url;
    }
    if (!html) {
      // v31: sem página → sem itens (visível no terminal)
      nfceLog(`serviço: ITENS — nenhuma página disponível para extrair itens da nota ${accessKey.slice(0, 8)}…`);
      await this.documents.updateHeader(accessKey, {
        parse_status: doc.parse_status === 'PENDING' ? 'FAILED' : doc.parse_status,
        needs_review: 1,
        ...(url ? { source_url: url } : {}),
      });
      return { items: 0, appliedToStock: 0, needsReview: 0 };
    }
    if (url && url !== doc.source_url) {
      await this.documents.updateHeader(accessKey, { source_url: url });
    }
    // v41: núcleo comum de ITENS — gravação + resolução de produtos. O estoque
    // automático segue no processItems (tela NFC-e); no Novo Lançamento o
    // usuário escolhe item a item (prepareFromHtml → autoStock: false).
    return this.storeAndResolveItems(accessKey, html, doc, { autoStock: true, storeHtml: !!htmlOverride });
  }

  /**
   * v41 — NÚCLEO COMUM de itens: grava os itens do HTML, resolve produtos
   * (tabela da verdade v37) e — SÓ quando autoStock — aplica o estoque nos
   * confiáveis. Recebe o HTML JÁ capturado; quem busca a página é o chamador.
   */
  private async storeAndResolveItems(
    accessKey: string,
    html: string,
    doc: NfceDocumentRow,
    opts: { autoStock: boolean; storeHtml: boolean }
  ): Promise<{ items: number; appliedToStock: number; needsReview: number }> {
    // v26: guarda a ÚLTIMA página capturada (diagnóstico — "Compartilhar página capturada")
    if (opts.storeHtml) {
      try {
        await this.db.runAsync(
          `INSERT INTO app_settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [`nfce_html_${accessKey}`, html.slice(0, 600_000)]
        );
      } catch {
        // diagnóstico é best-effort
      }
    }
    const rawItems = parseNfceItems(html);
    if (!rawItems.length) {
      // v40: parser não achou NENHUM item — layout inesperado (o resumo mostra qual)
      nfceStep(NFCE_STEP.ITENS, 'fail', `parser NÃO encontrou itens no HTML (${nfceHtmlSummary(html)}) — se persistir, use "Compartilhar página capturada" na revisão para me enviar o layout novo`);
      await this.documents.updateHeader(accessKey, { parse_status: 'FAILED', needs_review: 1 });
      return { items: 0, appliedToStock: 0, needsReview: 0 };
    }
    // v40: CONFERÊNCIA DE SOMA — a soma dos itens tem que bater com o total da
    // nota (centavo exato). Diferença = item faltando/duplicado/valor podre.
    const sumCents = rawItems.reduce((acc, r) => acc + (r.totalCents ?? 0), 0);
    const itemsWithoutTotal = rawItems.filter((r) => r.totalCents == null).length;
    const itemsWithoutCode = rawItems.filter((r) => !r.eanExtracted && !r.storeProductCode).length;
    const noteTotal = doc.gross_total_cents ?? doc.amount_paid_cents ?? null;
    let somaStatus: 'ok' | 'warn' = 'ok';
    let somaMsg: string;
    if (noteTotal == null) {
      somaMsg = 'total da nota indisponível — conferência de soma pulada';
      somaStatus = 'warn';
    } else {
      const diff = sumCents - noteTotal;
      somaMsg = `soma dos itens ${nfceBRL(sumCents)} vs total da nota ${nfceBRL(noteTotal)} — diferença ${nfceBRL(diff)}`;
      if (Math.abs(diff) > 1 || itemsWithoutTotal > 0) {
        somaStatus = 'warn';
        somaMsg += itemsWithoutTotal > 0 ? ` · ${itemsWithoutTotal} item(ns) sem valor legível` : ' · itens faltando/duplicados na página?';
      } else {
        somaMsg += ' · CONFERE no centavo';
      }
    }
    nfceStep(
      NFCE_STEP.ITENS,
      somaStatus,
      `${rawItems.length} item(ns) extraído(s) · ${itemsWithoutCode} sem código · ${somaMsg}`
    );
    // v31: itens encontrados — lista resumida linha a linha no terminal
    nfceLog(`serviço: ITENS — ${rawItems.length} item(ns) extraído(s):`);
    for (const raw of rawItems) {
      nfceLog(
        `serviço:   #${raw.lineNumber} ${raw.description ?? '(sem descrição)'} · ` +
        `código=${raw.eanExtracted ?? raw.storeProductCode ?? '?'} · qtd=${raw.qty ?? '?'} ${raw.unitOriginal ?? ''} · ` +
        `total=${raw.totalCents != null ? (raw.totalCents / 100).toFixed(2) : '?'}`
      );
    }

    let needsReview = 0;
    const trustedItemIds: string[] = [];

    /**
     * v37 — resolve UM item contra a TABELA DA VERDADE e grava o resultado
     * (produto + log da decisão). Usado na inserção nova E na re-resolução
     * de itens antigos que ficaram sem produto (aprendizado retroativo).
     */
    const resolveAndLink = async (args: {
      itemId: string;
      description: string;
      ean: string | null;
      code: string | null;
      qty: number | null;
      unitOriginal: string | null;
      line: number;
    }): Promise<void> => {
      const conversion = args.qty != null ? convertToBaseUnit(args.qty, args.unitOriginal) : null;
      const resolution = await this.productService.resolveOrRegister(
        doc.store_name,
        {
          ean: args.ean,
          storeProductCode: args.code,
          name: args.description,
          unitBase: conversion?.baseUnit ?? null,
          unitMeasure: productUnitMeasureFromNfce(args.unitOriginal),
        },
        { cnpj: doc.cnpj } // v37: o CNPJ é a chave da tabela da verdade
      );
      if (resolution.product) {
        await this.items.setProductId(args.itemId, resolution.product.id);
      }
      await this.items.setMatch(args.itemId, resolution.matchType, resolution.score ?? null);
      // v31: linha por item com o resultado do match (visível no terminal)
      nfceLog(
        `serviço:   #${args.line} ${args.description.slice(0, 40)} → ${resolution.matchType}` +
        `${resolution.score != null ? ` (${Math.round(resolution.score * 100)}%)` : ''}` +
        `${resolution.product ? ` · ${resolution.product.name.slice(0, 40)}` : ''}` +
        `${resolution.needsReview ? ' · REVISÃO' : ''}`
      );
      if (resolution.needsReview) needsReview++;
      // Guarda de unidade (v37): só vai ao estoque sozinho quando a dimensão
      // do item bate com a unidade-base do produto (KG→G com base G, etc.) —
      // item KG em produto UN fica vinculado MAS fora do estoque automático.
      const prodBase = resolution.product?.base_unit ?? null;
      const itemDim = conversion?.baseUnit ?? null;
      const unitOk = !prodBase || !itemDim || prodBase === itemDim;
      if (resolution.product && !resolution.needsReview && conversion && unitOk) {
        trustedItemIds.push(args.itemId);
      }
    };

    for (const raw of rawItems) {
      await this.productService.ensureMeasurementUnit(raw.unitOriginal);
      // Upsert tolerante: UNIQUE(access_key, line_number)
      const existing = await this.db.getFirstAsync<{ id: string }>(
        'SELECT id FROM nfce_items WHERE access_key = ? AND line_number = ?',
        [accessKey, raw.lineNumber]
      );
      if (existing) {
        // v26: reprocesso completa campos que a leitura antiga deixou vazios
        // (valor, quantidade, unidade, código da loja) — sem duplicar itens.
        await this.db.runAsync(
          `UPDATE nfce_items
              SET total_cents = COALESCE(total_cents, ?),
                  qty = COALESCE(qty, ?),
                  unit_original = COALESCE(unit_original, ?),
                  store_product_code = COALESCE(store_product_code, ?),
                  ean_extracted = COALESCE(ean_extracted, ?)
            WHERE id = ?`,
          [raw.totalCents, raw.qty, raw.unitOriginal, raw.storeProductCode, raw.eanExtracted, existing.id] as never
        );
        // v37 — RE-RESOLUÇÃO RETROATIVA: item que ficou SEM PRODUTO em leitura
        // antiga tenta de novo com a tabela da verdade de HOJE (com os aliases
        // aprendidos desde então). Item já resolvido NÃO é tocado.
        const row = await this.items.getById(existing.id);
        if (row && !row.product_id && row.status === 'PARSED' && raw.description) {
          await resolveAndLink({
            itemId: row.id,
            description: raw.description,
            ean: raw.eanExtracted,
            code: raw.storeProductCode,
            qty: raw.qty,
            unitOriginal: raw.unitOriginal,
            line: raw.lineNumber,
          });
        }
        continue;
      }

      const itemId = genId();
      await this.items.insert({
        id: itemId,
        access_key: accessKey,
        line_number: raw.lineNumber,
        description: raw.description,
        ean_extracted: raw.eanExtracted,
        store_product_code: raw.storeProductCode,
        qty: raw.qty,
        unit_original: raw.unitOriginal,
        total_cents: raw.totalCents,
        product_id: null,
        status: 'PARSED',
        stock_applied: 0,
      });

      if (raw.description) {
        await resolveAndLink({
          itemId,
          description: raw.description,
          ean: raw.eanExtracted,
          code: raw.storeProductCode,
          qty: raw.qty,
          unitOriginal: raw.unitOriginal,
          line: raw.lineNumber,
        });
      }
    }

    // Aplica estoque nos confiáveis (idempotente por item) — v41: SÓ no fluxo
    // automático; no formulário do Novo Lançamento o usuário decide por item.
    const appliedToStock = opts.autoStock
      ? await this.pantryService.applyNfceItems(accessKey, trustedItemIds)
      : 0;

    const counts = await this.items.countByStatus(accessKey);
    const parseStatus =
      counts.error > 0 || counts.ignored > 0 ? 'PARTIAL' : 'COMPLETE';
    await this.documents.updateHeader(accessKey, {
      parse_status: parseStatus,
      needs_review: await this.hasPendingReview(accessKey),
    });

    // v31: fechamento do processamento de itens
    nfceLog(`serviço: ITENS — conclusão: ${rawItems.length} extraído(s), ${appliedToStock} no estoque, ${needsReview} em revisão (status ${parseStatus})`);
    return { items: rawItems.length, appliedToStock, needsReview };
  }

  /**
   * v41 — PREPARAR A NOTA PARA O FORMULÁRIO (QR no Novo Lançamento):
   * grava o cabeçalho e os ITENS (com resolução de produtos/aprendizado v37)
   * mas NÃO cria lançamento e NÃO aplica estoque. O formulário do Novo
   * Lançamento é preenchido com o total da nota e o usuário escolhe TUDO
   * antes de salvar: categoria (item ▸ subitem), pagamento (conta/cartão),
   * data e, item a item, o que entra no estoque. O vínculo com o lançamento
   * nasce em attachToTransaction(), no momento do Salvar.
   */
  async prepareFromHtml(
    accessKey: string,
    html: string,
    sourceUrl: string | null
  ): Promise<{ accessKey: string; header: NfceHeader; items: NfcePreparedItem[]; alreadyRegistered: boolean }> {
    nfceLog(`serviço: HTML recebido do navegador (${nfceHtmlSummary(html)})`);
    const header = parseNfceHeader(html, accessKey);
    // Mesma conferência campo a campo da ingestão automática (trilha no terminal)
    const missing: string[] = [];
    if (!header.storeName) missing.push('loja');
    if (!header.cnpj) missing.push('CNPJ');
    if (!header.issuedAt) missing.push('emissão');
    if (header.amountPaidCents == null && header.grossTotalCents == null) missing.push('valor');
    const headerVals =
      `loja=${header.storeName ? nfceClip(header.storeName, 50) : 'NÃO ACHOU'} · CNPJ=${header.cnpj ?? 'NÃO ACHOU'} · ` +
      `emissão=${header.issuedAt ?? 'NÃO ACHOU'} · ` +
      `total=${nfceBRL(header.amountPaidCents)}` +
      `${header.grossTotalCents != null ? ` (produtos ${nfceBRL(header.grossTotalCents)})` : ''}`;
    if (missing.length < 4) {
      nfceStep(NFCE_STEP.CABECALHO, missing.length === 0 ? 'ok' : 'warn', missing.length === 0 ? headerVals : `${headerVals} · FALTOU: ${missing.join(', ')}`);
    } else {
      nfceStep(NFCE_STEP.CABECALHO, 'fail', `nada extraído do HTML (${nfceHtmlSummary(html)}) — a página provavelmente não é a nota`);
    }
    const registeredId = await this.findRegisteredTransactionId(accessKey);
    if (registeredId) {
      nfceLog('serviço: v41 — nota JÁ registrada com transação real → nada a preparar');
      return { accessKey, header, items: [], alreadyRegistered: true };
    }
    // UPSERT do cabeçalho SEM transação: o documento fica pronto enquanto o
    // usuário escolhe as opções do formulário (o lançamento nasce no Salvar).
    const existing = await this.documents.getById(accessKey);
    const headerFields = {
      store_name: header.storeName,
      cnpj: header.cnpj,
      issued_at: header.issuedAt,
      amount_paid_cents: header.amountPaidCents,
      gross_total_cents: header.grossTotalCents,
      discount_cents: header.discountCents,
      source_url: sourceUrl,
    };
    if (existing) {
      await this.documents.updateHeader(accessKey, {
        ...headerFields,
        parse_status: 'HEADER_ONLY',
        needs_review: 0,
      });
    } else {
      await this.documents.insert({
        access_key: accessKey,
        ...headerFields,
        parse_status: 'HEADER_ONLY',
        needs_review: 0,
        transaction_id: null,
      });
    }
    nfceStep(NFCE_STEP.RESULTADO, 'ok', `NOTA NO FORMULÁRIO — total ${nfceBRL(header.amountPaidCents ?? header.grossTotalCents)} · aguardando o usuário salvar (SEM lançamento automático)`);
    const doc = await this.documents.getById(accessKey);
    if (!doc) throw new Error('Documento NFC-e não encontrado');
    await this.storeAndResolveItems(accessKey, html, doc, { autoStock: false, storeHtml: true });
    const rows = await this.items.getByDocument(accessKey);
    const items: NfcePreparedItem[] = rows.map((r) => {
      const conversion = r.qty != null ? convertToBaseUnit(r.qty, r.unit_original) : null;
      const unitOk =
        !r.product_base_unit || !conversion?.baseUnit || r.product_base_unit === conversion.baseUnit;
      const canApplyStock =
        r.status === 'PARSED' && r.stock_applied === 0 && !!r.product_id && !!conversion && unitOk;
      // v59: fuzzy SÓ SUGERE — TODO FUZZY vai para revisão (a decisão é do usuário);
      // EAN/ALIAS continuam automáticos (são a verdade gravada pelo usuário)
      const needsReview =
        r.status === 'PARSED' &&
        (!r.product_id ||
          r.match_type === 'NEW' ||
          r.match_type === 'FUZZY');
      return {
        id: r.id,
        lineNumber: r.line_number,
        description: r.description,
        qty: r.qty,
        unitOriginal: r.unit_original,
        totalCents: r.total_cents,
        productId: r.product_id,
        productName: r.product_name ?? null,
        matchType: r.match_type ?? null,
        matchScore: r.match_score ?? null,
        status: r.status,
        stockApplied: r.stock_applied,
        canApplyStock,
        needsReview,
        unitClash: !!r.product_id && !!conversion?.baseUnit && !!r.product_base_unit && r.product_base_unit !== conversion.baseUnit,
      };
    });
    nfceLog(
      `serviço: v41 — itens prontos para o formulário: ${items.length} · ` +
      `${items.filter((i) => i.canApplyStock && !i.needsReview).length} elegível(is) p/ estoque · ` +
      `${items.filter((i) => i.needsReview).length} p/ revisão`
    );
    return { accessKey, header, items, alreadyRegistered: false };
  }

  /**
   * v41 — VINCULA A NOTA AO LANÇAMENTO CRIADO NO FORMULÁRIO:
   * grava transaction_id no documento e aplica o estoque SOMENTE dos itens
   * marcados como "incluir" (os excluídos ficam stock_applied = 0 e podem ser
   * aplicados depois na revisão — decisão reversível). Idempotente: reaplicar
   * os mesmos itens não duplica movimento no ledger.
   */
  async attachToTransaction(
    accessKey: string,
    txId: string,
    includeItemIds: string[]
  ): Promise<{ applied: number }> {
    const doc = await this.documents.getById(accessKey);
    if (!doc) throw new Error('Documento NFC-e não encontrado');
    if (doc.transaction_id && doc.transaction_id !== txId) {
      throw new Error('Esta nota já está anexada a outro lançamento — confira na tela NFC-e');
    }
    const applied = await this.pantryService.applyNfceItems(accessKey, includeItemIds);
    const counts = await this.items.countByStatus(accessKey);
    const parseStatus =
      counts.error > 0 || counts.ignored > 0
        ? 'PARTIAL'
        : doc.parse_status === 'PENDING'
          ? 'HEADER_ONLY'
          : doc.parse_status;
    await this.documents.updateHeader(accessKey, {
      transaction_id: txId,
      parse_status: parseStatus,
      needs_review: await this.hasPendingReview(accessKey),
    });
    nfceStep(NFCE_STEP.RESULTADO, 'ok', `lançamento (${txId.slice(0, 8)}…) vinculado à nota · ${applied} item(ns) ao estoque · ${includeItemIds.length} marcado(s)`);
    return { applied };
  }

  /**
   * v37 — HÁ PENDÊNCIA DE REVISÃO? (estável entre reprocessamentos)
   * Pendência real = item PARSED sem produto OU marcado para perguntar
   * (NEW sempre; FUZZY sempre — v59: fuzzy SÓ SUGERE, a decisão é do usuário
   * durante a NF, nunca unifica sozinho). Decisões MANUAIS e matches
   * automáticos (EAN/ALIAS) NÃO penduram o documento.
   */
  private async hasPendingReview(accessKey: string): Promise<0 | 1> {
    const row = await this.db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM nfce_items
        WHERE access_key = ? AND status = 'PARSED'
          AND ( product_id IS NULL
             OR match_type = 'NEW'
             OR match_type = 'FUZZY' )`,
      [accessKey]
    );
    return (row?.n ?? 0) > 0 ? 1 : 0;
  }

  /** Confirmar sugestão fuzzy (REVIEW_SUGGESTED) e aplicar ao estoque. */
  async confirmItemProduct(itemId: string): Promise<void> {
    const item = await this.items.getById(itemId);
    if (!item || !item.product_id) throw new Error('Item sem produto vinculado');
    const conversion = item.qty != null ? convertToBaseUnit(item.qty, item.unit_original) : null;
    if (!conversion) throw new Error('Unidade não conversível — ajuste manualmente na despensa');
    // v37: guarda de unidade — KG em produto UN não entra (dimensões diferentes)
    const product = await this.productService.getProduct(item.product_id);
    if (product?.base_unit && product.base_unit !== conversion.baseUnit) {
      throw new Error(
        `Unidade do item (${conversion.baseUnit}) difere da unidade do produto (${product.base_unit}) — registre manualmente na despensa`
      );
    }
    // v37: confirmar É decidir — grava o código na tabela da verdade
    const doc = await this.documents.getById(item.access_key);
    if (item.store_product_code) {
      await this.productService.recordDecision(item.product_id, {
        cnpj: doc?.cnpj ?? null,
        storeName: doc?.store_name ?? null,
        storeProductCode: item.store_product_code,
      });
    }
    await this.items.setMatch(itemId, 'MANUAL', item.match_score ?? null);
    await this.pantryService.applySingleNfceItem(item.access_key, itemId, item.product_id, conversion.deltaBase);
    await this.documents.updateHeader(item.access_key, { needs_review: await this.hasPendingReview(item.access_key) });
  }

  /**
   * v37 — vincula manualmente um item a um produto (seletor da revisão) e
   * GRAVA A DECISÃO: alias (CNPJ, código) + textual — a próxima nota daquela
   * loja resolve sozinha no passo 2. Alias antigo errado é REAPONTADO.
   */
  async linkItemToProduct(itemId: string, productId: string): Promise<void> {
    const item = await this.items.getById(itemId);
    if (!item) throw new Error('Item não encontrado');
    const doc = await this.documents.getById(item.access_key);
    await this.productService.recordDecision(productId, {
      cnpj: doc?.cnpj ?? null,
      storeName: doc?.store_name ?? null,
      storeProductCode: item.store_product_code,
      aliasText: item.description,
    });
    await this.items.setProductId(itemId, productId);
    await this.items.setMatch(itemId, 'MANUAL', 1);
    await this.items.setStatus(itemId, 'PARSED');
    await this.documents.updateHeader(item.access_key, { needs_review: await this.hasPendingReview(item.access_key) });
  }

  /** Ignora item (não entra em estoque). */
  async ignoreItem(itemId: string): Promise<void> {
    await this.items.setStatus(itemId, 'IGNORED');
  }

  /**
   * v37 — cria produto a partir de um item não resolvido e vincula.
   * Aceita categoria/subitem (classificação da revisão) e GRAVA A DECISÃO
   * (alias CNPJ+código) — a próxima nota daquela loja resolve sozinha.
   */
  async createProductFromItem(itemId: string, categoryId?: string | null): Promise<string> {
    const item = await this.items.getById(itemId);
    if (!item?.description) throw new Error('Item sem descrição');
    const conversion = item.qty != null ? convertToBaseUnit(item.qty, item.unit_original) : null;
    const product = await this.productService.createManualProduct({
      name: item.description,
      ean: item.ean_extracted,
      baseUnit: conversion?.baseUnit ?? 'UN',
      unitMeasure: productUnitMeasureFromNfce(item.unit_original),
      categoryId: categoryId ?? null,
    });
    const doc = await this.documents.getById(item.access_key);
    await this.productService.recordDecision(product.id, {
      cnpj: doc?.cnpj ?? null,
      storeName: doc?.store_name ?? null,
      storeProductCode: item.store_product_code,
      aliasText: null, // o nome do produto JÁ é a descrição do item
    });
    await this.items.setProductId(itemId, product.id);
    await this.items.setMatch(itemId, 'MANUAL', 1);
    await this.documents.updateHeader(item.access_key, { needs_review: await this.hasPendingReview(item.access_key) });
    return product.id;
  }

  /** v37: classificar o produto do item em categoria/subitem (persistido). */
  async setItemProductCategory(productId: string, categoryId: string | null): Promise<void> {
    await this.productService.setCategory(productId, categoryId);
  }

  async getDocument(accessKey: string) {
    const doc = await this.documents.getById(accessKey);
    if (!doc) return null;
    const items = await this.items.getByDocument(accessKey);
    return { document: doc, items };
  }

  async listDocuments(): Promise<(NfceDocumentRow & { tx_description: string | null })[]> {
    return this.documents.getAll();
  }

  /**
   * v18/v36 — BUSCA DA PÁGINA DA NOTA em múltiplos candidatos (URL escaneada
   * do QR com assinatura → portal público atual) com a IDENTIDADE NATIVA
   * ÚNICA (Dalvik — captura Reqable do usuário). v36: a reserva de navegador
   * (UA Mozilla) saiu — recusada em TODOS os testes reais (v30–v34), só
   * acrescentava espera morta; o papel de cliente de navegador é do MOTOR DO
   * APARELHO (WebView genuína).
   * Retorna o PRIMEIRO conteúdo que pareça a página da nota; se nenhum
   * responder, devolve { html: null } — a cadeia segue (navegador interno)
   * e o fluxo financeiro continua válido.
   */
  private async fetchNote(input: string): Promise<{ html: string | null; url: string | null }> {
    let accessKey = extractAccessKey(input) ?? '';
    const candidates = listConsultUrls(input, accessKey);
    // v31: fallback direto (fetch sem navegador) também aparece no terminal
    nfceLog(`serviço: fallback fetch direto (identidade Dalvik) com ${candidates.length} candidato(s)`);

    let lastUrl: string | null = null;
    let tentativas = 0;
    for (let i = 0; i < candidates.length; i++) {
      // v30/v34: espera aleatória de 2–5 s ENTRE pedidos (rate-limit do
      // portal — rajada em sequência imediata é padrão de robô e o firewall
      // bloqueia; o 1º pedido não espera).
      if (tentativas > 0) await new Promise((r) => setTimeout(r, sefazRetryDelayMs()));
      tentativas += 1;
      nfceLog(`serviço: fetch direto [identidade nativa (Dalvik)] canal ${i + 1}/${candidates.length}: ${candidates[i]}`);
      const html = await this.fetchHtml(candidates[i]);
      if (html) {
        nfceLog(`serviço: fetch direto canal ${i + 1} → página recebida (${nfceHtmlSummary(html)})`);
        accessKey = accessKey || extractAccessKey(candidates[i]) || '';
        return { html, url: candidates[i] };
      }
      nfceLog(`serviço: fetch direto canal ${i + 1} → vazio/rejeitado`);
      lastUrl = candidates[i];
    }
    nfceLog('serviço: fetch direto FALHOU em todos os canais (o firewall recusa o fetch — a reserva é o navegador interno)');
    return { html: null, url: lastUrl };
  }

  /**
   * v18/v36 — fetch de uma URL com a identidade nativa (cabeçalhos mínimos
   * estilo Java/HttpURLConnection — enfeite de navegador entregaria o
   * disfarce) e decodificação por charset.
   * Retorna null em qualquer falha (rede, HTTP != 200, WAF).
   */
  private async fetchHtml(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': NATIVE_UA,
          Accept: 'text/html, image/gif, image/jpeg, *; q=.2, */*; q=.2',
        },
      });
      // v40: o resultado HTTP cru aparece no terminal (status + tempo) —
      // é a linha que separa "portal recusou" de "portal nem respondeu".
      if (!res.ok) {
        nfceLog(`serviço: fetch HTTP ${res.status} ${res.statusText ?? ''} em ${nfceMs(Date.now() - t0)} — portal RESPONDEU mas recusou: ${url}`);
        return null;
      }
      const contentType = res.headers.get('content-type') ?? '';
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.length === 0) {
        nfceLog(`serviço: fetch HTTP 200 com CORPO VAZIO (0 bytes) em ${nfceMs(Date.now() - t0)}`);
        return null;
      }
      nfceLog(`serviço: fetch HTTP 200 · ${bytes.length} bytes · ${nfceMs(Date.now() - t0)} · content-type=${contentType || '?'}`);
      let text = bytesToUtf8(bytes);
      // v25: página do WAF (F5 BIG-IP) — detecção COMPLETA (a regex antiga
      // "Request Rejected" não pegava "The requested URL was rejected.", texto
      // REAL da página de rejeição, e a página virava "nota" com header vazio).
      // isFirewallRejectionPage nunca marca a nota verdadeira como rejeição.
      if (isFirewallRejectionPage(text)) {
        nfceLog('serviço: fetch recebeu a página de REJEIÇÃO do firewall — sem chance para o fetch (é a razão do navegador interno existir)');
        return null;
      }
      // Charset ISO-8859-1/latin1 declarado (ou texto suspeito de mojibake)
      if (/charset=(iso-8859-1|latin1|windows-1252)/i.test(contentType) || /charset=(iso-8859-1|latin1|windows-1252)/i.test(text)) {
        text = bytesToLatin1(bytes);
      }
      // Precisa parecer a página da nota (tem trechos-chave) OU ao menos HTML
      if (!/<html|<!doctype/i.test(text)) {
        nfceLog('serviço: fetch recebeu resposta que nem é HTML — canal inútil');
        return null;
      }
      return text;
    } catch (err) {
      // v40: a exceção do fetch NUNCA mais some — rede, DNS ou timeout
      const msg = err instanceof Error ? err.message : String(err);
      nfceLog(`serviço: fetch EXCEÇÃO em ${nfceMs(Date.now() - t0)}: ${msg} (timeout do app: ${Math.round(FETCH_TIMEOUT_MS / 1000)}s)`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Uint8Array -> string UTF-8 (sem depender de TextDecoder, ausente em alguns runtimes). */
function bytesToUtf8(bytes: Uint8Array): string {
  try {
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8').decode(bytes);
    }
  } catch {
    // cai no fallback
  }
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    } else {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      out += String.fromCodePoint(cp);
      i += 4;
    }
  }
  return out;
}

/** Uint8Array -> string latin1 (byte a byte) para páginas ISO-8859-1. */
function bytesToLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}
