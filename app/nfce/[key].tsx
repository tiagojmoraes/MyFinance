/** Revisão de NFC-e — resolução de produtos (TABELA DA VERDADE v37).
 *  v98: confirmações e assistente de 3 perguntas por item, resumo do que
 *  falta revisar e aplicação imediata do estoque nos itens confiáveis.
 *  v99 — TELA DE REVISÃO enxuta (pedido do usuário):
 *   · os 3 botões manuais de processo da revisão (itens / estoque /
 *     recaptura invisível) foram REMOVIDOS — a lista vem sozinha assim que a
 *     nota é lida na tela NFC-e (ou re-processada quando a página guardada
 *     resolve);
 *   · no fim da lista, um CARD DE CONFIRMAÇÃO com o total, a contagem de
 *     itens e o botão "Confirmar e abrir Novo Lançamento" leva a tela
 *     `/lancamento?nfce=…` já PREENCHIDA com os dados da nota;
 *   · quando a nota já está vinculada a um lançamento, a tela mostra
 *     "Esta nota já está lançada no Fluxo" e esconde o botão de confirmação.
 */

import React from 'react';
import { View, Text } from 'react-native';
import { showToast } from '../../lib/toast';
import { router, useLocalSearchParams } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Screen, Card, Button, Badge, SectionTitle, EmptyState, KeyValue, TextField, Segmented } from '../../src/components/ui';
import { convertToBaseUnit } from '../../src/parsers/nfce';
import { normalizeText } from '../../src/lib/text';
import { useDataEffect } from '../../src/components/useDataEffect';
import { useAppStore } from '../../src/store/appStore';
import { formatBRL } from '../../src/lib/money';
import { ymdToBr, spDateOfIso } from '../../src/lib/dates';
import { nfceLog } from '../../src/lib/nfcelog';

interface ItemRow {
  id: string;
  line_number: number;
  description: string | null;
  ean_extracted: string | null;
  store_product_code: string | null;
  qty: number | null;
  unit_original: string | null;
  total_cents: number | null;
  unit_price_cents?: number | null;
  product_id: string | null;
  product_name: string | null;
  product_base_unit?: 'G' | 'ML' | 'UN' | null;
  match_type?: string | null;
  match_score?: number | null;
  status: string;
  stock_applied: number;
}

interface CatOption {
  id: string;
  label: string;
}

/** v37: rótulo do log da decisão (como este item foi ligado ao produto). */
function matchBadge(item: ItemRow): { text: string; tone: 'auto' | 'ask' | 'manual' } | null {
  switch (item.match_type) {
    case 'EAN':
      return { text: 'auto · já conhecido', tone: 'auto' };
    case 'ALIAS':
      return { text: 'auto · já conhecido', tone: 'auto' };
    case 'FUZZY': {
      // v59: fuzzy SÓ sugere, nunca é "auto" — a decisão é do usuário durante a NF.
      const pct = item.match_score != null ? Math.round(item.match_score * 100) : null;
      return { text: `sugestão${pct != null ? ` ${pct}%` : ''} — confirme`, tone: 'ask' };
    }
    case 'MANUAL':
      return { text: 'sua decisão', tone: 'manual' };
    case 'NEW':
      return { text: 'novo — classifique uma vez', tone: 'ask' };
    default:
      return item.product_id ? { text: 'vinculado', tone: 'manual' } : null;
  }
}

const badgeToneCls: Record<'auto' | 'ask' | 'manual', string> = {
  auto: 'text-emerald-700 bg-emerald-50',
  ask: 'text-amber-700 bg-amber-50',
  manual: 'text-sky-700 bg-sky-50',
};

/** Dimensão da unidade do item (KG→G, L→ML, UN→UN). */
function dimOf(unit: string | null | undefined): 'G' | 'ML' | 'UN' | null {
  return unit ? convertToBaseUnit(1, unit)?.baseUnit ?? null : null;
}

export default function NfceReviewScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [doc, setDoc] = React.useState<{ store_name: string | null; cnpj: string | null; amount_paid_cents: number | null; issued_at: string | null; parse_status: string; needs_review: number; source_url: string | null; transaction_id: string | null } | null>(null);
  const [items, setItems] = React.useState<ItemRow[]>([]);
  const [products, setProducts] = React.useState<Array<{ id: string; label: string }>>([]);
  const [cats, setCats] = React.useState<CatOption[]>([]);
  // v37 — classificação na revisão: seletor de produto e categoria/subitem
  const [linkingId, setLinkingId] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [creatingId, setCreatingId] = React.useState<string | null>(null);
  const [newCatId, setNewCatId] = React.useState<string | null>(null);
  // v59: Despensa perguntada DURANTE a vinculação (SEMPRE / PERGUNTAR / NUNCA) — 5 SEMPRE + 2 NUNCA viram 0 perguntas na próxima nota.
  const [linkPolicy, setLinkPolicy] = React.useState<'ALWAYS' | 'ASK' | 'NEVER'>('ASK');
  // v67 (MELHORIA 1): item com a pergunta "Incluir no estoque?" aberta (resposta NÃO)
  const [stockAskId, setStockAskId] = React.useState<string | null>(null);
  // v98 — assistente de 3 perguntas por item (DESEMPENHO/QUESTÃO DO USUÁRIO):
  // · WIZARD_STEP 'NONE' = item resolvido, sem pergunta aberta;
  // · 'CATALOG'  = Q1 — vai para o catálogo?
  // · 'STOCK'    = Q2 — controle de estoque?
  // · 'CATCAT'   = Q1-sim + seleção da categoria do produto;
  // · 'NOTEVER'  = Q3 — não entrar nunca mais / só nesta nota.
  type WizardStep = 'NONE' | 'CATALOG' | 'STOCK' | 'CATCAT' | 'NOTEVER';
  const [wizard, setWizard] = React.useState<{ itemId: string; step: WizardStep } | null>(null);
  // contador de itens já decididos nesta sessão (UX: barra de progresso no topo)
  const [decidedCount, setDecidedCount] = React.useState(0);

  /** v99: re-processamento AUTOMÁTICO (uma vez por tela) quando o documento
   *  está sem itens. Sem botões — a lista aparece sozinha. */
  const autoProcessedRef = React.useRef(false);
  const [autoProcessing, setAutoProcessing] = React.useState(false);

  const load = React.useCallback(async () => {
    const detail = await services.nfce.getDocument(key);
    if (!detail) return;
    setDoc({
      store_name: detail.document.store_name,
      cnpj: detail.document.cnpj ?? null,
      amount_paid_cents: detail.document.amount_paid_cents,
      issued_at: detail.document.issued_at,
      parse_status: detail.document.parse_status,
      needs_review: detail.document.needs_review,
      source_url: (detail.document as unknown as { source_url?: string | null }).source_url ?? null,
      transaction_id: detail.document.transaction_id ?? null,
    });
    setItems(detail.items as unknown as ItemRow[]);
    const prods = await services.products.listProducts();
    setProducts(prods.map((p) => ({ id: p.id, label: p.name })));
    try {
      const rows = await services.categories.listActive();
      const parents = new Map(rows.filter((c) => !c.parent_id).map((c) => [c.id, c.name]));
      // v67 (MELHORIA 1): classificação de produto usa CATEGORIAS DE DÉBITO
      // (despesa) — produto de nota é compra; BOTH entra também.
      setCats(
        rows
          .filter((c: { direction?: string | null }) => c.direction !== 'CREDIT')
          .filter((c) => !!c.parent_id || !rows.some((x) => x.parent_id === c.id))
          .map((c) => ({
            id: c.id,
            label: c.parent_id ? `${parents.get(c.parent_id) ?? '?'} ▸ ${c.name}` : c.name,
          }))
      );
    } catch {
      setCats([]);
    }
  }, [services, key]);

  useDataEffect(load, [key]);

  /** v99 — se ainda não há itens, tenta extrair da página capturada ou
   *  reler do motor do aparelho uma única vez por tela (sem botões). */
  React.useEffect(() => {
    if (!doc || items.length > 0 || autoProcessedRef.current) return;
    autoProcessedRef.current = true;
    setAutoProcessing(true);
    (async () => {
      try {
        const res = await services.nfce.processItems(key);
        nfceLog(`tela: auto-process — ${res.items} item(ns) · ${res.appliedToStock} ao estoque · ${res.needsReview} p/ revisão`);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'err');
      } finally {
        setAutoProcessing(false);
        bump();
        await load();
      }
    })();
  }, [doc, items.length, key, services, load, bump]);

  const confirmFuzzy = async (item: ItemRow) => {
    try {
      await services.nfce.confirmItemProduct(item.id);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v8 — seletor "Vincular produto": busca manual no catálogo (sem sugestões
   *  por semelhança; o fuzzy de nome existe só na tela "＋ Criar produto"). */
  const openLinker = (item: ItemRow) => {
    setLinkingId(item.id);
    setSearch('');
  };

  const linkTo = async (item: ItemRow, productId: string) => {
    try {
      await services.nfce.linkItemToProduct(item.id, productId);
      await services.products.setPantryPolicy(productId, linkPolicy);
      showToast('Vínculo gravado — a próxima nota desta loja resolve sozinha');
      setLinkingId(null);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  const createFromItem = async (item: ItemRow) => {
    try {
      // v67 (MELHORIA 1): cria CLASSIFICADO (categoria de débito) e grava a
      // decisão — o estoque é perguntado na sequência, item a item.
      await services.nfce.createProductFromItem(item.id, newCatId);
      showToast('Produto criado e classificado — decisão gravada');
      setCreatingId(null);
      setNewCatId(null);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v67 (MELHORIA 1): NÃO incluir no estoque — SÓ NESTA NOTA (Apenas agora). */
  const skipStockNow = async (item: ItemRow) => {
    try {
      await services.nfce.ignoreItem(item.id);
      setStockAskId(null);
      showToast('Item fora do estoque — apenas nesta nota');
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v67 (MELHORIA 1): NUNCA incluir no estoque — grava pantry_policy = NUNCA
   *  no produto; as próximas notas deste produto nem perguntam. */
  const skipStockAlways = async (item: ItemRow) => {
    try {
      if (item.product_id) {
        await services.products.setPantryPolicy(item.product_id, 'NEVER');
      }
      await services.nfce.ignoreItem(item.id);
      setStockAskId(null);
      showToast('Sempre NUNCA: este produto não entra no estoque (memória gravada)');
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v26: exporta o HTML capturado da SEFAZ — é o que permite corrigir o leitor
   *  para o layout REAL da nota quando os itens não aparecem. */
  const shareCaptured = async () => {
    try {
      const html = await services.nfce.getCapturedHtml(key);
      if (!html) {
        showToast('Nenhuma página capturada — refaça a leitura da nota na tela NFC-e', 'err');
        return;
      }
      const path = `${FileSystem.cacheDirectory}nfce-${key.slice(-8)}.html`;
      await FileSystem.writeAsStringAsync(path, html);
      await Sharing.shareAsync(path, { mimeType: 'text/html', dialogTitle: 'Página capturada da NFC-e' });
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  const ignore = async (item: ItemRow) => {
    // v87: sem try/catch, um erro do serviço virava "unhandled rejection"
    // (sem aviso na tela) — o usuário ficava sem saber por que nada mudou.
    try {
      await services.nfce.ignoreItem(item.id);
      setDecidedCount((c) => c + 1);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v98 — abre o assistente (Q1: catálogo?) para um item ainda sem destino. */
  const startWizard = (item: ItemRow) => {
    setWizard({ itemId: item.id, step: 'CATALOG' });
  };
  /** v98 — executa a decisão do assistente e fecha. */
  const applyWizard = async (decision: {
    catalog: boolean;
    stockControl?: boolean;
    neverAgain?: boolean;
  }) => {
    if (!wizard) return;
    try {
      await services.nfce.decideImport(wizard.itemId, {
        catalog: decision.catalog,
        stockControl: !!decision.stockControl,
        neverAgain: !!decision.neverAgain,
        categoryId: newCatId,
      });
      setDecidedCount((c) => c + 1);
      setWizard(null);
      setCreatingId(null);
      setNewCatId(null);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  const filteredProducts = (q: string) => {
    const nq = normalizeText(q);
    const list = nq ? products.filter((p) => normalizeText(p.label).includes(nq)) : products;
    return list.slice(0, 6);
  };

  return (
    <Screen title="Revisão NFC-e" subtitle={doc?.store_name ?? 'Documento'}>
      {doc ? (
        <Card>
          <KeyValue k="Estabelecimento" v={doc.store_name ?? 'Não identificado'} bold />
          <KeyValue k="CNPJ" v={doc.cnpj ?? '—'} />
          <KeyValue k="Valor pago" v={doc.amount_paid_cents != null ? formatBRL(doc.amount_paid_cents) : '—'} />
          <KeyValue k="Emissão" v={doc.issued_at ? ymdToBr(spDateOfIso(doc.issued_at)) : '—'} />
          <View className="flex-row gap-2 mt-1">
            <Badge status={doc.parse_status} />
            {doc.needs_review ? <Badge status="REVIEW" /> : null}
          </View>
        </Card>
      ) : null}

      <SectionTitle>Itens ({items.length})</SectionTitle>
      {items.length === 0 ? (
        autoProcessing ? (
          <Card><Text className="text-sm text-slate-500">Buscando itens na página capturada…</Text></Card>
        ) : (
          <View className="gap-2">
            <EmptyState
              icon="🧾"
              title="Nenhum item encontrado"
              hint="A página guardada não tem itens — confira se a nota foi lida com a chave certa ou use Compartilhar página capturada (diagnóstico) para reportar."
            />
            {/* v26: diagnóstico — compartilhar o HTML para o mantenedor. */}
            <Button label="Compartilhar página capturada (diagnóstico)" variant="outline" onPress={shareCaptured} />
          </View>
        )
      ) : null}

      {/* v99 — CARD DE CONFIRMAÇÃO (no fluxo pedido pelo usuário): a tela da
        revisão NÃO cria lançamento; aqui o usuário CONFIRMA e abre o
        formulário "Novo Lançamento" com a nota já preenchida. Itens sem
        revisão podem ser finalizados (a NIC-e também anexa o estoque dos
        itens marcados ao salvar). */}
      {doc ? (
        <Card className="gap-2">
          <Text className="font-semibold text-slate-900">Conferir e lançar</Text>
          <Text className="text-xs text-slate-500">
            {doc.store_name ?? 'Loja não identificada'} ·{' '}
            {doc.amount_paid_cents != null ? formatBRL(doc.amount_paid_cents) : 'valor não lido'} ·{' '}
            {items.length} item(ns)
          </Text>
          {doc.transaction_id ? (
            <View className="gap-1.5">
              <Text className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2.5 py-2">
                Esta nota já está vinculada a um lançamento — Confira no Fluxo.
              </Text>
              <Button
                label="Abrir o lançamento no Fluxo"
                variant="outline"
                onPress={() => router.push('/fluxo')}
              />
            </View>
          ) : (
            <>
              <Text className="text-xs text-slate-500">
                Ao continuar, a nota abre no formulário Novo Lançamento com valor total, data, descrição e os itens da nota. Você define categoria, pagamento e o que entra no estoque, depois SALVA.
              </Text>
              <Button
                label="Confirmar e abrir Novo Lançamento"
                onPress={() => {
                  nfceLog(`tela: CONFIRMAÇÃO — indo para Novo Lançamento com a nota ${key.slice(0, 8)}…`);
                  router.push(`/lancamento?nfce=${key}`);
                }}
                disabled={items.length === 0}
              />
              {doc.needs_review || items.some((it) => it.match_type === 'FUZZY' || it.match_type === 'NEW' || !it.product_id) ? (
                <Text className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2.5 py-2">
                  Há itens pendentes de revisão — finalize as decisões em CADA item acima antes de confirmar, ou continue e conclua tudo no formulário de Novo Lançamento depois.
                </Text>
              ) : null}
            </>
          )}
        </Card>
      ) : null}

      {items.map((item) => {
        const mb = matchBadge(item);
        const itemDim = dimOf(item.unit_original);
        const unitClash =
          !!item.product_id && !item.stock_applied && item.status !== 'IGNORED' &&
          !!item.product_base_unit && !!itemDim && item.product_base_unit !== itemDim;
        return (
        <Card key={item.id} className="!py-3">
          <View className="flex-row justify-between items-start gap-2">
            <View className="flex-1">
              <Text className="font-semibold text-slate-900" numberOfLines={2}>{item.description ?? '(sem descrição)'}</Text>
              {/* v98: linha de DETALHES do item — qtde, valor unitário, total.
                A soma dos itens lidos continua aparecendo no rodapé da tela. */}
              <Text className="text-xs text-slate-500 mt-0.5">
                Qtde: {item.qty ?? '—'} {item.unit_original ?? ''}{' · '}Un: {item.unit_original ?? '—'}
                {item.unit_price_cents != null
                  ? `\u00b7 Vl. unit.: ${formatBRL(item.unit_price_cents)}`
                  : ''}
              </Text>
              {/* v59: SEM EAN na tela — o usuário não sabe o que é EAN olhando a NF.
                  O EAN continua sendo aprendido sozinho por dentro (resolveOrRegister). */}
              {item.store_product_code ? (<Text className="text-xs text-slate-500">Código: {item.store_product_code}</Text>) : null}
              <Text className="text-xs font-semibold text-slate-600">
                {item.total_cents != null ? formatBRL(item.total_cents) : '—'}
              </Text>
              <View className="flex-row flex-wrap items-center gap-1 mt-1">
                <Text className="text-xs text-slate-500 bg-slate-50 px-1.5 py-0.5 rounded">
                  {item.product_name ? `→ ${item.product_name}` : 'produto não vinculado'}
                </Text>
                {mb ? (
                  <Text className={`text-xs px-1.5 py-0.5 rounded ${badgeToneCls[mb.tone]}`}>{mb.text}</Text>
                ) : null}
                {item.stock_applied ? (
                  <Text className="text-xs text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">no estoque</Text>
                ) : null}
                {unitClash ? (
                  <Text className="text-xs text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
                    {itemDim} ≠ {item.product_base_unit} — fora do estoque
                  </Text>
                ) : null}
                {item.status === 'IGNORED' ? <Text className="text-xs text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">ignorado</Text> : null}
              </View>
            </View>
          </View>

          {/* v37 — seletor "Vincular produto" (com sugestões ordenadas por parecença) */}
          {linkingId === item.id ? (
            <View className="mt-2 gap-1.5">
              <TextField label="Buscar produto" value={search} onChangeText={setSearch} placeholder="Ex.: mamao" />
              <Text className="text-xs text-slate-500">Despensa para este produto (vale p/ as próximas notas)</Text>
              <Segmented<'ALWAYS' | 'ASK' | 'NEVER'> options={[{ value: 'ALWAYS', label: 'Sempre' }, { value: 'ASK', label: 'Perguntar' }, { value: 'NEVER', label: 'Nunca' }]} value={linkPolicy} onChange={setLinkPolicy} />
              {filteredProducts(search).map((p) => (
                <MiniAction key={p.id} label={`→ ${p.label}`} onPress={() => linkTo(item, p.id)} tone="primary" />
              ))}
              {filteredProducts(search).length === 0 ? (
                <Text className="text-xs text-slate-400">Nenhum produto encontrado — use "Criar produto".</Text>
              ) : null}
              <MiniAction label="Cancelar" onPress={() => setLinkingId(null)} tone="muted" />
            </View>
          ) : null}

          {/* v67 (MELHORIA 1): criação INLINE — nome + categoria de DÉBITO na
              hora, sem sair da nota (antes abria o catálogo em outra tela). */}
          {creatingId === item.id ? (
            <View className="mt-2 gap-1.5">
              <Text className="text-xs text-slate-500">
                Novo produto "{item.description ?? '(sem descrição)'}" — classifique com uma categoria de despesa (item ▸ subitem). A decisão fica gravada: a próxima nota desta loja resolve sozinha.
              </Text>
              <CategoriaSelect cats={cats} value={newCatId} onChange={setNewCatId} />
              <View className="flex-row flex-wrap gap-1.5">
                <MiniAction label="Criar produto e classificar" onPress={() => createFromItem(item)} tone="primary" />
                <MiniAction label="Cancelar" onPress={() => { setCreatingId(null); setNewCatId(null); }} tone="muted" />
              </View>
            </View>
          ) : null}

          {/* v67 (MELHORIA 1): pergunta do ESTOQUE — "Incluir no estoque?" com
              NÃO = "Apenas agora" (só nesta nota) ou "Sempre" (NUNCA, gravado) */}
          {stockAskId === item.id && item.product_id ? (
            <View className="mt-2 gap-1.5 rounded-xl border border-amber-200 bg-amber-50 p-2.5">
              <Text className="text-xs font-semibold text-amber-800">
                Incluir "{item.product_name ?? item.description}" no estoque?
              </Text>
              <View className="flex-row flex-wrap gap-1.5">
                <MiniAction label="Sim, incluir no estoque" onPress={() => confirmFuzzy(item)} tone="primary" />
                <MiniAction label="Apenas agora (fica fora)" onPress={() => skipStockNow(item)} tone="muted" />
                <MiniAction label="Sempre (NUNCA perguntar)" onPress={() => skipStockAlways(item)} tone="muted" />
                <MiniAction label="Voltar" onPress={() => setStockAskId(null)} tone="muted" />
              </View>
              <Text className="text-xs text-amber-700">
                "Sempre" grava a memória NUNCA: as próximas notas deste produto nem perguntam.
              </Text>
            </View>
          ) : null}

          {/* v98 — ASSISTENTE DE 3 PERGUNTAS POR ITEM (na hora da importação):
            · Q1 (CATALOG): "Vai para o catálogo de produtos?" — sim avança
              para Q2; não cai em Q3 (nota: nunca / só nesta).
            · Q2 (STOCK): "Quer controle de estoque?" — sim grava policy ALWAYS
              + aplica estoque; não grava policy NEVER.
            · Q3 (NOTEVER): "Não entrar só nesta nota / sempre?" — sem/não
              sai do item para esta nota; sempre grava em `nfce_item_ignores`
              e as próximas notas desta loja pulam o item de cara. */}
          {wizard?.itemId === item.id ? (
            <View className="mt-2 gap-1.5 rounded-xl border border-sky-200 bg-sky-50 p-2.5">
              {wizard.step === 'CATALOG' ? (
                <>
                  <Text className="text-xs font-semibold text-sky-900">
                    Pergunta 1 de 2: "{item.description ?? 'item'}" vai para o catálogo de produtos?
                  </Text>
                  <View className="flex-row flex-wrap gap-1.5">
                    <MiniAction
                      label="Sim, vai pro catálogo"
                      onPress={() => setWizard({ itemId: item.id, step: 'CATCAT' })}
                      tone="primary"
                    />
                    <MiniAction
                      label="Não vai"
                      onPress={() => setWizard({ itemId: item.id, step: 'NOTEVER' })}
                      tone="muted"
                    />
                    <MiniAction label="Voltar" onPress={() => setWizard(null)} tone="muted" />
                  </View>
                </>
              ) : wizard.step === 'CATCAT' ? (
                <>
                  <Text className="text-xs font-semibold text-sky-900">
                    Categoria de despesa (opcional) → depois pergunta 2
                  </Text>
                  <CategoriaSelect cats={cats} value={newCatId} onChange={setNewCatId} />
                  <View className="flex-row flex-wrap gap-1.5">
                    <MiniAction
                      label="Próxima (controle de estoque)"
                      onPress={() => setWizard({ itemId: item.id, step: 'STOCK' })}
                      tone="primary"
                    />
                    <MiniAction
                      label="Voltar"
                      onPress={() => setWizard({ itemId: item.id, step: 'CATALOG' })}
                      tone="muted"
                    />
                  </View>
                </>
              ) : wizard.step === 'STOCK' ? (
                <>
                  <Text className="text-xs font-semibold text-sky-900">
                    Pergunta 2 de 2: quer controle de estoque por este item?
                  </Text>
                  <View className="flex-row flex-wrap gap-1.5">
                    <MiniAction
                      label="Sim, com controle de estoque"
                      onPress={() => applyWizard({ catalog: true, stockControl: true })}
                      tone="primary"
                    />
                    <MiniAction
                      label="Não (só catálogo)"
                      onPress={() => applyWizard({ catalog: true, stockControl: false })}
                      tone="muted"
                    />
                    <MiniAction
                      label="Voltar"
                      onPress={() => setWizard({ itemId: item.id, step: 'CATCAT' })}
                      tone="muted"
                    />
                  </View>
                </>
              ) : (
                <>
                  <Text className="text-xs font-semibold text-sky-900">
                    Quer que este item não entre {item.product_id ? 'nesta nota' : 'nesta nota'} ou para sempre?
                  </Text>
                  <View className="flex-row flex-wrap gap-1.5">
                    <MiniAction
                      label="Só nesta nota"
                      onPress={() => applyWizard({ catalog: false, neverAgain: false })}
                      tone="muted"
                    />
                    <MiniAction
                      label="Nunca (lembrar para sempre)"
                      onPress={() => applyWizard({ catalog: false, neverAgain: true })}
                      tone="primary"
                    />
                    <MiniAction
                      label="Voltar"
                      onPress={() => setWizard({ itemId: item.id, step: 'CATALOG' })}
                      tone="muted"
                    />
                  </View>
                </>
              )}
            </View>
          ) : null}

          {/* v67 (MELHORIA 1) — AÇÕES GUIADAS do item, na ordem da tabela da verdade:
              fuzzy → "É esse / É outro / + Produto novo / Ignorar"; sem produto →
              "É outro (vincular) / + Produto novo / Ignorar"; com produto e sem
              estoque → pergunta "Incluir no estoque?".
              v98: o botão PRINCIPAL virou "Decidir item (3 perguntas)" —
              abre o assistente CATALOG/STOCK/NOTEVER por item. */}
          {item.status !== 'IGNORED' && linkingId !== item.id && creatingId !== item.id && stockAskId !== item.id && !wizard ? (
            <View className="flex-row flex-wrap gap-1.5 mt-2">
              <MiniAction label="Decidir item (3 perguntas)" onPress={() => startWizard(item)} tone="primary" />
              {item.product_id ? (
                <MiniAction label="Vincular produto" onPress={() => openLinker(item)} tone="muted" />
              ) : null}
              <MiniAction label="Ignorar" onPress={() => ignore(item)} tone="muted" />
            </View>
          ) : null}
        </Card>
        );
      })}
    </Screen>
  );
}

/** v37: seletor de categoria/subitem ("Mercado ▸ Frutas") — decisão persistida. */
function CategoriaSelect({ cats, value, onChange }: { cats: CatOption[]; value: string | null; onChange: (id: string | null) => void }) {
  return (
    <View className="gap-1">
      <Text className="text-xs text-slate-500">Categoria (item ▸ subitem) — opcional</Text>
      <View className="flex-row flex-wrap gap-1.5">
        {cats.slice(0, 12).map((c) => (
          <Text
            key={c.id}
            onPress={() => onChange(value === c.id ? null : c.id)}
            className={`text-xs px-2 py-1 rounded-full ${
              value === c.id ? 'bg-emerald-600 text-white font-semibold' : 'bg-slate-100 text-slate-600'
            }`}
          >
            {c.label}
          </Text>
        ))}
      </View>
      {cats.length === 0 ? (
        <Text className="text-xs text-slate-400">Nenhuma categoria ativa — crie em Categorias.</Text>
      ) : null}
    </View>
  );
}

function MiniAction({ label, onPress, tone = 'primary' }: { label: string; onPress: () => void; tone?: 'primary' | 'muted' }) {
  return (
    <View className={`rounded-lg px-2.5 py-1.5 ${tone === 'primary' ? 'bg-emerald-50' : 'bg-slate-100'}`}>
      <Text onPress={onPress} className={`text-xs font-semibold ${tone === 'primary' ? 'text-emerald-700' : 'text-slate-600'}`}>
        {label}
      </Text>
    </View>
  );
}
