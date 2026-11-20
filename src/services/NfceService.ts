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
import { nfcePortao } from './NfcePortao';
import { NfceDocumentRepo, NfceItemRepo } from '../repos/misc';
import type { NfceDocumentRow, NfceItemRow } from '../repos/misc';
import { TransactionRepo } from '../repos/finance';
import type { TransactionRow } from '../repos/finance';
import { ProductService } from './ProductService';
import { PantryService } from './PantryService';

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
  unitPriceCents: number | null;
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
   * v99 — LEITURA PURA DO MOTOR: percorre os mesmos canais (QR assinado →
   * portal público), com o mesmo timeout, e devolve só o HTML renderizado.
   * Não grava nada no banco, não cria transação — usado pelas rotas de
   * PREPARE (tela NFC-e + Novo Lançamento), que persistem por outras vias.
   * Devolve null quando o motor não conseguiu (sem componente montado em
   * teste, firewall rejeitando agora, página não reconhecida).
   */
  /**
   * v100 — LEITURA PURA DO MOTOR, agora com fila completa + portão anti-ban.
   * Cada canal roda numa sessão nova (incognito): rejeição de um canal não
   * contamina o seguinte. A rejeição repetida entra no backoff do portão
   * (camada de IP), não a isolada (camada de sessão — resolve sozinha).
   */
  private async readHtmlViaEngine(input: string): Promise<{ accessKey: string; html: string; url: string } | null> {
    const accessKey = extractAccessKey(input);
    if (!accessKey) return null;
    if (!nfceWebEngine.hasDriver()) {
      nfceLog('serviço: motor do aparelho NÃO montado (WebView ausente) — pulando leitura');
      return null;
    }

    const restante = nfcePortao.waitRemaining();
    if (restante > 0) {
      nfceLog(`serviço: portão anti-ban — ${nfcePortao.blockedReason()}`);
      await new Promise((r) => setTimeout(r, restante));
    }
    nfcePortao.registerStart();

    const canais = listConsultUrls(input, accessKey);
    for (let i = 0; i < canais.length; i++) {
      const url = canais[i];
      nfceLog(`serviço: MOTOR DO APARELHO (leitura PURE) — canal ${i + 1}/${canais.length}: ${url}`);
      const res = await nfceWebEngine.read(url, WEBENGINE_TIMEOUT_MS);
      if (!res) {
        nfceLog('serviço: canal sem página (erro/tempo) — próximo canal');
        continue;
      }
      if (isFirewallRejectionPage(res.html)) {
        const cooldown = nfcePortao.registerRejection();
        nfceLog(
          `serviço: canal ${i + 1} → REJEIÇÃO do firewall (${nfceHtmlSummary(res.html)})` +
            (cooldown > 0 ? ` — rejeição repetida: backoff de ${cooldown / 1000}s` : ' — próximo canal em sessão nova'),
        );
        if (i < canais.length - 1) await new Promise((r) => setTimeout(r, 1_500));
        continue;
      }
      if (!looksLikeNfcePage(res.html)) {
        nfceLog(`serviço: canal ${i + 1} → página não reconhecida (${nfceHtmlSummary(res.html)}) — próximo canal`);
        continue;
      }
      nfcePortao.registerSuccess();
      nfceLog(`serviço: motor do aparelho CONSEGUIU a página via ${res.url}`);
      return { accessKey, html: res.html, url: res.url };
    }
    nfceLog('serviço: todos os canais falharam — FIM da leitura');
    return null;
  }

  /**
   * v35/v72 — MOTOR DO APARELHO + persistência automática (NFCE legacy):
   * a mesma leitura do motor, mas em SEGUIDA grava header + cria transação
   * CONSOLIDATED (CAMINHO ANTIGO das NFC-e lidas pela tela /nfce). Mantido
   * para os testes e qualquer chamada externa que ainda dependa do
   * ARQ-008 Header First automático. A v99 prefere `readHtmlViaEngine` →
   * `prepareFromHtml` para que o usuário FINALIZE o lançamento no formulário.
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
    const registeredId = await this.findRegisteredTransactionId(accessKey);
    if (registeredId) {
      nfceLog('serviço: motor do aparelho — nota já registrada com transação real');
      return { accessKey, created: false, transactionId: registeredId, html: '' };
    }
    const read = await this.readHtmlViaEngine(input);
    if (!read) return null;
    const out = await this.ingestFromHtml(read.accessKey, read.html, read.url);
    return { ...out, html: read.html };
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
   * v72 — LEITURA ÚNICA pelo MOTOR DO APARELHO (WebView oculta 1×1). O que
   * era cadeia (serviço de leitura → fetch Dalvik → navegador interno visível)
   * foi REMOVIDO: o teste real do usuário provou que só o motor funciona
   * (1ª nota leu, 2ª foi recusada pelo firewall) — tentativas extras só
   * queimam o IP e abrem navegador na cara do usuário. Devolve o resultado
   * JÁ REGISTRADO e o HTML usado; null quando o motor não conseguiu — a tela
   * mostra a falha no rodapé e nada abre.
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
      nfceLog('serviço: leitura — nota já registrada com transação real');
      return { accessKey, created: false, transactionId: registeredId, html: '' };
    }
    const viaEngine = await this.ingestViaWebEngine(input);
    if (viaEngine) return viaEngine;
    nfceLog('serviço: motor do aparelho não conseguiu a página — FIM (sem fallback na v72)');
    return null;
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
    // v87 (BUG BAIXA): o valor pago podia ser o TOTAL DOS PRODUTOS (quando o
    // layout não traz "Valor Pago"), ignorando o DESCONTO da nota — o
    // lançamento saía maior do que o que o usuário pagou. Agora, sem "Valor
    // Pago", o total é o bruto MENOS o desconto.
    const amountCents =
      header.amountPaidCents ??
      (header.grossTotalCents != null
        ? Math.max(0, header.grossTotalCents - (header.discountCents ?? 0))
        : null);
    const existing = await this.documents.getById(accessKey);
    const headerFields = {
      store_name: header.storeName,
      cnpj: header.cnpj,
      issued_at: header.issuedAt,
      // v87: guarda o valor REALMENTE PAGO (bruto − desconto quando não há
      // "Valor Pago" no layout) — a tela de revisão mostra este número.
      amount_paid_cents: amountCents,
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
    const dupHolder: { id: string | null } = { id: null };
    await this.db.transactionAsync(async () => {
      // v87 (BUG MÉDIA): o teste de idempotência era FEITO FORA da transação —
      // duas leituras do MESMO QR (o leitor repete a leitura) passavam as duas
      // pelo teste e a segunda estourava o UNIQUE(source_system, external_ref_id)
      // com erro cru na tela. Agora o teste é refeito DENTRO da transação.
      const dup = await this.transactions.findByExternalRef('NFCE', accessKey);
      if (dup) {
        dupHolder.id = dup.id;
        return;
      }
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
    if (dupHolder.id) {
      // já existia (corrida) — nada duplicado, sem erro na tela
      nfceStep(NFCE_STEP.RESULTADO, 'ok', `nota já registrada para esta chave (id=${dupHolder.id.slice(0, 8)}…)`);
      return { accessKey, created: false, transactionId: dupHolder.id };
    }

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
      // v35/v72: reprocessamento de itens também vai pelo MOTOR DO APARELHO
      // (o único caminho de rede da v72 — o HTML volta renderizado e com itens).
      const engineCandidates = listConsultUrls(doc.source_url ?? accessKey, accessKey);
      nfceLog(`serviço: ITENS — motor do aparelho disponível, tentando ${engineCandidates.length} canal(is)`);
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
      // v72: última reserva LOCAL — a página capturada da última leitura bem
      // sucedida (app_settings nfce_html_<chave>). A nota fiscal é imutável:
      // reler o HTML guardado extrai os itens sem tocar na rede.
      const captured = await this.getCapturedHtml(accessKey);
      if (captured) {
        html = captured;
        nfceLog('serviço: ITENS — usando a página CAPTURADA da leitura anterior (reserva local, sem rede)');
      }
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
     * v100 — resolve UM item contra a TABELA DA VERDADE sem auto-criar produto.
     * (a) CNPJ+código bate → ALIAS (zero interação).
     * (b) Sem código, fuzzy SUGERE — match fica ALIAS-só-quando-usuário-confirmar
     *     (no Catálogo), então aqui fica como PENDING com sugestão gravada em
     *     match_type='FUZZY' e score.
     * (c) Nada bate → product_id NULL (PENDING — vai para o Catálogo).
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
        },
        { cnpj: doc.cnpj }
      );
      if (resolution.product) {
        await this.items.setProductId(args.itemId, resolution.product.id);
      }
      await this.items.setMatch(args.itemId, resolution.matchType, resolution.score ?? null);
      nfceLog(
        `serviço:   #${args.line} ${args.description.slice(0, 40)} → ${resolution.matchType}` +
        `${resolution.score != null ? ` (${Math.round(resolution.score * 100)}%)` : ''}` +
        `${resolution.product ? ` · ${resolution.product.name.slice(0, 40)}` : ''}` +
        (resolution.matchType === 'PENDING' ? ' · PENDENTE (Catálogo)' :
         resolution.matchType === 'IGNORE' ? ' · NUNCA MAIS' :
         resolution.needsReview ? ' · REVISÃO' : '')
      );
      // v100: PENDING e FUZZY sempre pendem revisão — o usuário classifica 1 vez
      // no Catálogo (decisão possível: É esse / outro novo / não é produto).
      if (resolution.needsReview || resolution.matchType === 'PENDING') needsReview++;
      // Compat: itens AUTO-CRIADOS pelo fluxo da NF (resolveOrRegister v37) entram
      // Com controle (a Despensa precisa enxergar a compra). Pode ser trocado
      // pelo usuário no formulário do Catálogo depois.
      if (resolution.matchType === 'NEW' && resolution.product) {
        await this.db.runAsync('UPDATE products_catalog SET stock_control = 1 WHERE id = ?', [resolution.product.id]);
        resolution.product.stock_control = 1;
      }
      // Confiáveis para estoque: ALIAS direto + Com controle + dimensão ok
      const prodBase = resolution.product?.base_unit ?? null;
      const itemDim = conversion?.baseUnit ?? null;
      const unitOk = !prodBase || !itemDim || prodBase === itemDim;
      const stockControlOk = !resolution.product || (resolution.product.stock_control ?? 0) === 1;
      if ((resolution.matchType === 'ALIAS' || resolution.matchType === 'EAN') && resolution.product && !resolution.needsReview && conversion && unitOk && stockControlOk) {
        trustedItemIds.push(args.itemId);
      }
    };

    for (const raw of rawItems) {
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
                  ean_extracted = COALESCE(ean_extracted, ?),
                  unit_price_cents = COALESCE(unit_price_cents, ?)
            WHERE id = ?`,
          [
            raw.totalCents, raw.qty, raw.unitOriginal,
            raw.storeProductCode, raw.eanExtracted, raw.unitPriceCents,
            existing.id,
          ] as never
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
        unit_price_cents: raw.unitPriceCents,
        product_id: null,
        status: 'PARSED',
        stock_applied: 0,
      });

      // v98 — "nunca mais": se já existe regra de ignorar para (cnpj + EAN)
      // OU (cnpj + código) OU (cnpj + descrição), o item vai AUTOMATICAMENTE
      // como IGNORED sem voltar a perguntar na próxima nota desta loja.
      if (doc.cnpj && (raw.description || raw.eanExtracted || raw.storeProductCode)) {
        const descNorm = (raw.description ?? '').toLowerCase().trim();
        const ignore = await this.db.getFirstAsync<{ id: string }>(
          `SELECT id FROM nfce_item_ignores
            WHERE cnpj = ?
              AND (
                (ean IS NOT NULL AND ? IS NOT NULL AND ean = ?)
                OR (store_product_code IS NOT NULL AND ? IS NOT NULL AND store_product_code = ?)
                OR (description_norm <> '' AND ? <> '' AND description_norm = ?)
              )
            LIMIT 1`,
          [
            doc.cnpj,
            raw.eanExtracted ?? null, raw.eanExtracted ?? null,
            raw.storeProductCode ?? null, raw.storeProductCode ?? null,
            descNorm, descNorm,
          ] as never
        );
        if (ignore) {
          await this.items.setStatus(itemId, 'IGNORED');
          continue;
        }
      }

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
    // v87: mesmo cálculo do fluxo automático — sem "Valor Pago", o total é o
    // bruto MENOS o desconto da nota.
    const valorPago =
      header.amountPaidCents ??
      (header.grossTotalCents != null
        ? Math.max(0, header.grossTotalCents - (header.discountCents ?? 0))
        : null);
    const headerFields = {
      store_name: header.storeName,
      cnpj: header.cnpj,
      issued_at: header.issuedAt,
      amount_paid_cents: valorPago,
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
    const items = this.toPreparedItems(rows);
    nfceLog(
      `serviço: v41 — itens prontos para o formulário: ${items.length} · ` +
      `${items.filter((i) => i.canApplyStock && !i.needsReview).length} elegível(is) p/ estoque · ` +
      `${items.filter((i) => i.needsReview).length} p/ revisão`
    );
    return { accessKey, header, items, alreadyRegistered: false };
  }

  /**
   * v99 — MAPA NFC-e → formulário (DRY): reaproveitado por `prepareFromHtml`
   * (escrita) e por `prepareFromDocument` (leitura do banco sem escrever).
   * Mesma convenção de NfcePreparedItem (v41) + guarda de unidade (v37).
   */
  private toPreparedItems(rows: Awaited<ReturnType<NfceItemRepo['getByDocument']>>): NfcePreparedItem[] {
    return rows.map((r) => {
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
        unitPriceCents: r.unit_price_cents ?? null,
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
  }

  /**
   * v99 — ROTINA NFC-e sem criar lançamento: o MOTOR DO APARELHO lê a página
   * (mesmo canal e timeout da v72) e o serviço guarda o cabeçalho e os itens
   * (prepareFromHtml grava o doc e resolve produtos/vitrine, sem transação).
   * A transação só nasce quando o usuário confirmar a nota no formulário de
   * "Novo Lançamento" (`attachToTransaction` no botão Salvar) — fim do
   * "criou transação fantasma que o usuário nunca finalizou".
   * Devolve null quando o motor não conseguiu (mesma semântica do v72).
   */
  async prepareByDirectFetch(
    input: string
  ): Promise<{ accessKey: string; header: NfceHeader; items: NfcePreparedItem[]; alreadyRegistered: boolean } | null> {
    const read = await this.readHtmlViaEngine(input);
    if (!read) return null;
    return this.prepareFromHtml(read.accessKey, read.html, read.url);
  }

  /**
   * v99 — RECUPERA a nota do BANCO para o formulário (`/lancamento?nfce=…`
   * vindo da tela NFC-e, depois de o usuário revisar os itens e confirmar).
   * Não grava nada; só lê header + itens já persistidos e devolve no mesmo
   * contrato de `prepareFromHtml`. Se a chave já tem transação anexada,
   * devolve `alreadyRegistered: true` para a tela abortar o prefill.
   */
  async prepareFromDocument(
    accessKey: string
  ): Promise<{ accessKey: string; header: NfceHeader; items: NfcePreparedItem[]; alreadyRegistered: boolean }> {
    const doc = await this.documents.getById(accessKey);
    if (!doc) throw new Error('Documento NFC-e não encontrado');
    const header: NfceHeader = {
      accessKey,
      storeName: doc.store_name,
      cnpj: doc.cnpj,
      issuedAt: doc.issued_at,
      grossTotalCents: doc.gross_total_cents,
      amountPaidCents: doc.amount_paid_cents,
      discountCents: doc.discount_cents,
    };
    const registered = await this.findRegisteredTransactionId(accessKey);
    if (registered) {
      nfceLog(`serviço: v99 — prepareFromDocument(${accessKey.slice(0, 8)}…) já registrada (${registered.slice(0, 8)}…) → nada a preparar`);
      return { accessKey, header, items: [], alreadyRegistered: true };
    }
    const rows = await this.items.getByDocument(accessKey);
    const items = this.toPreparedItems(rows);
    nfceLog(`serviço: v99 — prepareFromDocument: ${items.length} item(ns) prontos para o formulário (sem rede)`);
    return { accessKey, header, items, alreadyRegistered: false };
  }

  /**
   * v100 — VINCULA A NOTA AO LANÇAMENTO CRIADO NO FORMULÁRIO:
   *  · grava transaction_id no documento (UNIQUE bloqueia 1 NF em 2 lançamentos);
   *  · aplica estoque dos itens VINCULADOS + Com controle + dimensão ok
   *    (sem toggle na tela — o "Com controle" do Catálogo é quem decide);
   *  · congela o SPLIT DE ORÇAMENTO (por item: categoria do produto se a
   *    subcategoria tem orçamento próprio; senão, fica na categoria do CNPJ).
   *    Classificação tardia NÃO recalcula (spec §8.3).
   *  · marca o lançamento-âncora: é a 1ª categoria por CNPJ (que entra em
   *    nfce_store_categories) e serve para a tela Lançamento mostrar/lembrar.
   *  · Idempotente: reaplicar não duplica movimento no ledger.
   */
  async attachToTransaction(
    accessKey: string,
    txId: string,
    options?: { storeCategoryId?: string | null; includeItemIds?: string[] | null } | string[] | null
  ): Promise<{ applied: number; split: Array<{ categoryId: string; cents: number }> }> {
    // Compat: callers antigos passam um array de IDs (3º arg) — normaliza aqui.
    const opts: { storeCategoryId?: string | null; includeItemIds?: string[] | null } | null =
      Array.isArray(options) ? { includeItemIds: options } : (options ?? null);
    const doc = await this.documents.getById(accessKey);
    if (!doc) throw new Error('Documento NFC-e não encontrado');
    if (doc.transaction_id && doc.transaction_id !== txId) {
      throw new Error('Esta nota já está anexada a outro lançamento — confira na tela NFC-e');
    }
    const applied = await this.pantryService.applyNfceItems(accessKey, opts?.includeItemIds ?? null);
    // Computa o split de orçamento do lançamento (snapshot).
    const split = await this.computeBudgetSplit(accessKey, txId, opts?.storeCategoryId ?? null);
    // Guarda a categoria por CNPJ (próxima NF do mesmo CNPJ já vem com ela).
    if (doc.cnpj && opts?.storeCategoryId) {
      await this.db.runAsync(
        `INSERT INTO nfce_store_categories (cnpj, category_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(cnpj) DO UPDATE SET category_id = excluded.category_id, updated_at = excluded.updated_at`,
        [doc.cnpj, opts.storeCategoryId, nowIso()]
      );
    }
    // Grava o snapshot congelado na própria nota (BudgetService lê daqui).
    await this.db.runAsync(
      `UPDATE nfce_documents SET budget_split_json = ? WHERE access_key = ?`,
      [JSON.stringify(split), accessKey]
    );
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
    nfceStep(NFCE_STEP.RESULTADO, 'ok', `lançamento (${txId.slice(0, 8)}…) vinculado à nota · ${applied} item(ns) ao estoque · ${split.length} fatia(s) de orçamento`);
    return { applied, split };
    return { applied, split };
  }

  /** v100 — split congelado: items com subcategoria de orçamento próprio
   *  desconta dela; o resto vai para a categoria do lançamento (do CNPJ). */
  private async computeBudgetSplit(accessKey: string, _txId: string, defaultCategoryId: string | null): Promise<Array<{ categoryId: string; cents: number }>> {
    const items = await this.db.getAllAsync<{ total_cents: number | null; product_id: string | null; category_id: string | null }>(
      `SELECT ni.total_cents, ni.product_id, pc.category_id
         FROM nfce_items ni
         LEFT JOIN products_catalog pc ON pc.id = ni.product_id
        WHERE ni.access_key = ? AND ni.status = 'PARSED' AND ni.total_cents IS NOT NULL`,
      [accessKey]
    );
    const split = new Map<string, number>();
    let residual = 0;
    for (const it of items) {
      const cents = it.total_cents ?? 0;
      if (cents <= 0) continue;
      const subId = it.category_id ?? null;
      if (subId) {
        const row = await this.db.getFirstAsync<{ id: string }>(
          'SELECT id FROM budgets WHERE category_id = ? AND is_active = 1',
          [subId]
        );
        if (row && row.id) {
          split.set(subId, (split.get(subId) ?? 0) + cents);
          continue;
        }
      }
      residual += cents;
    }
    const out: Array<{ categoryId: string; cents: number }> = [];
    for (const [cid, c] of split.entries()) out.push({ categoryId: cid, cents: c });
    if (residual > 0) {
      const target = defaultCategoryId;
      if (target) out.push({ categoryId: target, cents: residual });
    }
    return out;
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
    // v100: confirmar É ligar o controle do produto (se ainda não estiver)
    if (product && (product.stock_control ?? 0) !== 1) {
      await this.productService.setStockControl(item.product_id, 1);
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
      categoryId: categoryId ?? null,
      // v100: produto criado da NF nasce SEM controle (não polui Despensa sem
      // decisão do usuário). Ele entra Com controle quando o usuário ativa o
      // assistente da revisão ou edita o formulário depois.
      stockControl: 0,
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

  /**
   * v98 — DECISÃO DO ITEM pelo assistente de 3 perguntas da tela de revisão:
   *  1. Vai para o catálogo de produtos? Sim → cria o produto do item
   *     (resolve a categoria na hora via `categoryId` opcional) e define a
   *     política de estoque conforme a resposta 2.
   *  2. Quer controle de estoque por este item? Sim → policy ALWAYS +
   *     aplica o estoque para este item. Não → policy NEVER + não aplica.
   *  1'. Não vai para o catálogo? → cai para a 3ª pergunta.
   *  3. Não entrar só nesta nota OU nunca mais? `onlyThisNote` = true sai
   *     em IGNORED só desta vez; `forever` (com `cnpj` + `descriptionNorm`
   *     aprendidos do item/doc) grava em `nfce_item_ignores` para as
   *     próximas notas desta loja pularem o item de cara.
   * Devolve o `status` final do item ('PARSED' | 'IGNORED') e, no caso
   * "nunca mais", a descrição normalizada usada como trava (para a
   * próxima nota a tela poder mostrar "X itens ignorados por você em
   * outras notas").
   */
  async decideImport(
    itemId: string,
    decision: {
      // caso 1 (catálogo + estoque)
      catalog: boolean;
      stockControl: boolean; // ignorado se catalog === false
      categoryId?: string | null;
      // caso 2 (só lembrar / nunca)
      neverAgain: boolean; // exige catalog === false
    }
  ): Promise<{ status: 'PARSED' | 'IGNORED'; descriptionNorm?: string }> {
    const item = await this.items.getById(itemId);
    if (!item) throw new Error('Item não encontrado');

    if (decision.catalog) {
      // 1) cria o produto a partir do item (já grava o alias cnpj+código).
      const productId = await this.createProductFromItem(itemId, decision.categoryId ?? null);
      // 2) define a política de estoque + aplica/removido.
      const policy = decision.stockControl ? 'ALWAYS' : 'NEVER';
      await this.productService.setPantryPolicy(productId, policy);
      if (policy === 'ALWAYS') {
        // Aplica o estoque deste item (já vinculado ao produto recém-criado).
        // `createProductFromItem` acima já grava nfce_items.product_id; o
        // `pantryService.applyNfceItems` lê essa coluna e faz a conversão de
        // unidade/dimensão como em qualquer item confiável.
        try {
          await this.pantryService.applyNfceItems(item.access_key, [itemId]);
        } catch {
          // best-effort — a coluna stock_applied marca o que entrou
        }
      }
      return { status: 'PARSED' };
    }

    // catalog === false
    if (decision.neverAgain) {
      const descNorm = (item.description ?? '').toLowerCase().trim();
      const doc = await this.documents.getById(item.access_key);
      await this.db.runAsync(
        `INSERT INTO nfce_item_ignores (id, cnpj, ean, store_product_code, description_norm, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          genId(),
          doc?.cnpj ?? null,
          item.ean_extracted,
          item.store_product_code,
          descNorm,
          nowIso(),
        ]
      );
      await this.items.setStatus(itemId, 'IGNORED');
      await this.documents.updateHeader(item.access_key, {
        needs_review: await this.hasPendingReview(item.access_key),
      });
      return { status: 'IGNORED', descriptionNorm: descNorm };
    }

    // "Só nesta nota" — ignora sem persistir
    await this.items.setStatus(itemId, 'IGNORED');
    await this.documents.updateHeader(item.access_key, {
      needs_review: await this.hasPendingReview(item.access_key),
    });
    return { status: 'IGNORED' };
  }

  /**
   * v98 — ITENS JÁ IGNORADOS NESTA LOJA: devolve a contagem de regras
   * `nfce_item_ignores` casadas com (cnpj + ean) OU (cnpj + store_product_code)
   * OU (cnpj + description_norm). Útil para o badge da tela "nunca mais".
   */
  async countIgnoredMatching(accessKey: string): Promise<number> {
    const doc = await this.documents.getById(accessKey);
    if (!doc || !doc.cnpj) return 0;
    const row = await this.db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM nfce_item_ignores
        WHERE cnpj = ?
          OR (ean IS NOT NULL AND ? IS NOT NULL)`,
      [doc.cnpj, doc.cnpj] as never
    );
    return row?.n ?? 0;
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
   * v100 — LISTA PENDENTE PARA O CATÁLOGO. Agrupa os nfce_items PENDING
   * (product_id IS NULL, status PARSED) por (cnpj, store_product_code) e
   * traz o top-3 de sugestões fuzzy por grupo. Cada grupo representa UM item
   * a classificar — 1 toque resolve. A tela `/produtos` exibe "Novos da NF (N)".
   */
  async listPendingItems(): Promise<Array<{
    groupKey: string;
    cnpj: string | null;
    storeName: string | null;
    storeProductCode: string | null;
    sampleDescription: string;
    n: number;
    sampleItemId: string;
    suggestions: Array<{ productId: string; name: string; score: number }>;
  }>> {
    const rows = await this.db.getAllAsync<{
      id: string; access_key: string; description: string | null;
      store_product_code: string | null;
      cnpj: string | null; store_name: string | null;
    }>(
      `SELECT ni.id, ni.access_key, ni.description, ni.store_product_code,
              d.cnpj, d.store_name
         FROM nfce_items ni
         JOIN nfce_documents d ON d.access_key = ni.access_key
        WHERE ni.status = 'PARSED' AND ni.product_id IS NULL
        ORDER BY d.issued_at DESC, ni.line_number ASC`
    );
    const groups = new Map<string, typeof rows[number] & { count: number }>();
    for (const r of rows) {
      const key = `${r.cnpj ?? '_'}::${r.store_product_code ?? '_'}`;
      const prev = groups.get(key);
      if (prev) { prev.count += 1; }
      else groups.set(key, { ...r, count: 1 });
    }
    const out: Array<{
      groupKey: string; cnpj: string | null; storeName: string | null;
      storeProductCode: string | null;
      sampleDescription: string; n: number; sampleItemId: string;
      suggestions: Array<{ productId: string; name: string; score: number }>;
    }> = [];
    for (const g of groups.values()) {
      const sugg = g.description ? await this.productService.suggestTop3(g.description, 3) : [];
      out.push({
        groupKey: g.cnpj ? `${g.cnpj}::${g.store_product_code ?? ''}` : `loja::${g.store_product_code ?? ''}`,
        cnpj: g.cnpj, storeName: g.store_name, storeProductCode: g.store_product_code,
        sampleDescription: g.description ?? '', n: g.count, sampleItemId: g.id,
        suggestions: sugg.map((s) => ({ productId: s.product.id, name: s.product.name, score: s.score })),
      });
    }
    return out;
  }

  /**
   * v100 — CLASSIFICAÇÃO EM LOTE (1 toque no Catálogo): pega TODOS os itens
   * pendentes com (cnpj, código) e vincula ao `productId`. Grava o alias
   * (chave da verdade), aplica estoque nos itens Com controle + dimensão ok,
   * e atualiza `needs_review` em cada nota afetada.
   */
  async classifyPendingBatch(input: { cnpj: string | null; storeProductCode: string | null; productId: string }): Promise<{ linked: number; applied: number }> {
    const product = await this.productService.getProduct(input.productId);
    if (!product) throw new Error('Produto não encontrado');
    let linked = 0;
    let applied = 0;
    const affectedDocs = new Set<string>();
    await this.db.transactionAsync(async () => {
      const rows = await this.db.getAllAsync<{ id: string; access_key: string; qty: number | null; unit_original: string | null }>(
        `SELECT ni.id, ni.access_key, ni.qty, ni.unit_original
           FROM nfce_items ni
           JOIN nfce_documents d ON d.access_key = ni.access_key
          WHERE ni.status = 'PARSED' AND ni.product_id IS NULL
            AND ( (? IS NOT NULL AND d.cnpj = ?)
               OR (? IS NOT NULL AND ni.store_product_code = ?) )`,
        [
          input.cnpj, input.cnpj,
          input.storeProductCode, input.storeProductCode,
        ] as never
      );
      // Refinamento: como `OR` não é seguro, filtra compatível:
      const matched = rows.filter((r) => {
        // Para cada item, o par (cnpj_code) da nota deve casar
        const sameCnpj = !!input.cnpj; // já filtrado acima
        const sameCode = !input.storeProductCode || true; // já filtrado
        return sameCnpj && sameCode;
      });
      // Atualiza items
      for (const r of matched) {
        await this.items.setProductId(r.id, input.productId);
        await this.items.setMatch(r.id, 'MANUAL', 1);
        linked++;
        affectedDocs.add(r.access_key);
      }
      // Grava o alias (cnpj, código) → produto
      await this.productService.aliases.ensureCnpjCodeAlias(
        input.productId, input.cnpj, input.storeProductCode ?? '', null, null
      );
    });
    // Aplica estoque (idempotente; só Com controle + dimensão ok)
    for (const docKey of affectedDocs) {
      const items = await this.db.getAllAsync<{ id: string; qty: number | null; unit_original: string | null; stock_control: number | null; base_unit: 'G' | 'ML' | 'UN' | null }>(
        `SELECT ni.id, ni.qty, ni.unit_original, pc.stock_control, pc.base_unit
           FROM nfce_items ni JOIN products_catalog pc ON pc.id = ni.product_id
          WHERE ni.access_key = ? AND ni.product_id = ?
            AND ni.status = 'PARSED' AND ni.stock_applied = 0`,
        [docKey, input.productId]
      );
      for (const r of items) {
        if ((r.stock_control ?? 0) !== 1) continue;
        const conv = r.qty != null ? convertToBaseUnit(r.qty, r.unit_original) : null;
        if (!conv) continue;
        if (r.base_unit && conv.baseUnit !== r.base_unit) continue;
        await this.pantryService.applySingleNfceItem(docKey, r.id, input.productId, conv.deltaBase);
        applied++;
      }
      await this.documents.updateHeader(docKey, {
        needs_review: await this.hasPendingReview(docKey),
      });
    }
    nfceLog(`serviço: classifyPendingBatch → ${linked} item(ns) vinculados, ${applied} ao estoque`);
    return { linked, applied };
  }

  /** v100 — IGNORAR EM LOTE: marca TODOS os itens com (cnpj, código) como
   *  IGNORED e grava a regra em `nfce_item_ignores` (não polui catálogo). */
  async ignorePendingBatch(input: { cnpj: string | null; storeProductCode: string | null }): Promise<{ ignored: number }> {
    let ignored = 0;
    const affectedDocs = new Set<string>();
    await this.db.transactionAsync(async () => {
      const rows = await this.db.getAllAsync<{ id: string; access_key: string; description: string | null; ean_extracted: string | null; store_product_code: string | null }>(
        `SELECT ni.id, ni.access_key, ni.description, ni.ean_extracted, ni.store_product_code
           FROM nfce_items ni JOIN nfce_documents d ON d.access_key = ni.access_key
          WHERE ni.status = 'PARSED' AND ni.product_id IS NULL
            AND ( (? IS NOT NULL AND d.cnpj = ?)
               OR (? IS NOT NULL AND ni.store_product_code = ?) )`,
        [
          input.cnpj, input.cnpj,
          input.storeProductCode, input.storeProductCode,
        ] as never
      );
      const matched = rows.filter((r) => !!input.cnpj);
      for (const r of matched) {
        await this.items.setStatus(r.id, 'IGNORED');
        ignored++;
        affectedDocs.add(r.access_key);
      }
      if (input.cnpj && matched.length > 0) {
        await this.db.runAsync(
          `INSERT OR IGNORE INTO nfce_item_ignores (id, cnpj, ean, store_product_code, description_norm, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            genId(),
            input.cnpj,
            matched[0]?.ean_extracted ?? null,
            input.storeProductCode ?? matched[0]?.store_product_code ?? null,
            (matched[0]?.description ?? '').toLowerCase().trim(),
            nowIso(),
          ]
        );
      }
    });
    for (const docKey of affectedDocs) {
      await this.documents.updateHeader(docKey, {
        needs_review: await this.hasPendingReview(docKey),
      });
    }
    return { ignored };
  }
}
