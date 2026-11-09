/** Revisão de NFC-e — resolução de produtos (TABELA DA VERDADE v37).
 *  v18 (bug 6): mostra o ESTABELECIMENTO e o CNPJ da nota e, em cada item,
 *  os dados obrigatórios da extração: NOME DO PRODUTO, QUANTIDADE (qtde),
 *  UNIDADE DE MEDIDA (un) e CÓDIGO DO PRODUTO.
 *  v37/v59: cada item mostra COMO foi resolvido (já conhecido, sugestão, sua decisão, novo)
 *  sem termos técnicos (sem EAN). — e o usuário classifica o que faltar:
 *  "Vincular produto" (com sugestões da tabela da verdade) e "Criar produto"
 *  já com categoria/subitem. A decisão é gravada: a próxima nota daquele
 *  CNPJ resolve sozinha — só pergunta dos novos.
 *  v67 (MELHORIA 1) — FLUXO GUIADO ITEM A ITEM:
 *   1. resolução na ordem EAN → Alias (código da loja) → sugestão fuzzy;
 *   2. sugestão fuzzy pergunta com botões claros: "É esse (X%)" · "É outro" ·
 *      "+ Produto novo" · "Ignorar";
 *   3. produto novo é CLASSIFICADO NA HORA aqui na revisão (categorias de
 *      DÉBITO/despesa) — sem sair da nota;
 *   4. produto resolvido e ainda fora do estoque pergunta "Incluir no
 *      estoque?" — não: "Apenas agora" (só nesta nota) ou "Sempre"
 *      (grava pantry_policy = NUNCA — as próximas notas nem perguntam). */

import React from 'react';
import { View, Text } from 'react-native';
import { showToast } from '../../lib/toast';
import { useLocalSearchParams } from 'expo-router';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Screen, Card, Button, Badge, SectionTitle, EmptyState, KeyValue, TextField, Segmented } from '../../src/components/ui';
import { NfceWebFetch } from '../../src/components/NfceWebFetch';
import { listConsultUrls, convertToBaseUnit } from '../../src/parsers/nfce';
import { normalizeText } from '../../src/lib/text';
import { useDataEffect } from '../../src/components/useDataEffect';
import { useAppStore } from '../../src/store/appStore';
import { formatBRL } from '../../src/lib/money';
import { ymdToBr } from '../../src/lib/dates';

interface ItemRow {
  id: string;
  line_number: number;
  description: string | null;
  ean_extracted: string | null;
  store_product_code: string | null;
  qty: number | null;
  unit_original: string | null;
  total_cents: number | null;
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
  const [doc, setDoc] = React.useState<{ store_name: string | null; cnpj: string | null; amount_paid_cents: number | null; issued_at: string | null; parse_status: string; needs_review: number; source_url: string | null } | null>(null);
  const [items, setItems] = React.useState<ItemRow[]>([]);
  const [products, setProducts] = React.useState<Array<{ id: string; label: string }>>([]);
  const [cats, setCats] = React.useState<CatOption[]>([]);
  const [busy, setBusy] = React.useState(false);
  // v37 — classificação na revisão: seletor de produto e categoria/subitem
  const [linkingId, setLinkingId] = React.useState<string | null>(null);
  const [suggestions, setSuggestions] = React.useState<Array<{ id: string; label: string; pct: number }>>([]);
  const [search, setSearch] = React.useState('');
  const [creatingId, setCreatingId] = React.useState<string | null>(null);
  const [newCatId, setNewCatId] = React.useState<string | null>(null);
  // v59: Despensa perguntada DURANTE a vinculação (SEMPRE / PERGUNTAR / NUNCA) — 5 SEMPRE + 2 NUNCA viram 0 perguntas na próxima nota.
  const [linkPolicy, setLinkPolicy] = React.useState<'ALWAYS' | 'ASK' | 'NEVER'>('ASK');
  // v67 (MELHORIA 1): item com a pergunta "Incluir no estoque?" aberta (resposta NÃO)
  const [stockAskId, setStockAskId] = React.useState<string | null>(null);

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

  const process = async () => {
    setBusy(true);
    try {
      const res = await services.nfce.processItems(key);
      showToast(`Itens processados: ${res.items} · ${res.appliedToStock} ao estoque · ${res.needsReview} para revisão`);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  // v19: re-tentativa pelo NAVEGADOR INTERNO (a página da SEFAZ exige navegador;
  // o fetch direto cai no desafio F5). Quando webUrl != null, o WebView fora da
  // tela carrega a página oficial e devolve o HTML — que alimenta processItems.
  const [webUrl, setWebUrl] = React.useState<string | null>(null);
  const recapture = () => {
    const url = doc?.source_url ?? null;
    if (!url) {
      showToast('Esta nota não tem URL do QR guardada — escaneie o QR Code novamente na tela NFC-e', 'err');
      return;
    }
    setBusy(true);
    setWebUrl(url);
  };

  const applyAll = async () => {
    try {
      const n = await services.pantry.applyNfceItems(key);
      showToast(`${n} item(ns) aplicado(s) ao estoque`);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  const confirmFuzzy = async (item: ItemRow) => {
    try {
      await services.nfce.confirmItemProduct(item.id);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v37: abre o seletor "Vincular produto" com sugestões da tabela da verdade. */
  const openLinker = async (item: ItemRow) => {
    setLinkingId(item.id);
    setSearch('');
    try {
      const sugg = item.description ? await services.products.suggestProducts(item.description, 6) : [];
      setSuggestions(sugg.map((s) => ({ id: s.product.id, label: s.product.name, pct: Math.round(s.score * 100) })));
    } catch {
      setSuggestions([]);
    }
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
        showToast('Nenhuma página capturada ainda — use "Buscar página oficial de novo"', 'err');
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
    await services.nfce.ignoreItem(item.id);
    bump();
    await load();
  };

  const filteredProducts = (q: string) => {
    const nq = normalizeText(q);
    const list = suggestions.length && !nq
      ? suggestions.map((s) => ({ id: s.id, label: `${s.label} · ${s.pct}%` }))
      : (nq
          ? products.filter((p) => normalizeText(p.label).includes(nq))
          : suggestions.map((s) => ({ id: s.id, label: `${s.label} · ${s.pct}%` })));
    return list.slice(0, 6);
  };

  return (
    <Screen title="Revisão NFC-e" subtitle={doc?.store_name ?? 'Documento'}>
      {webUrl ? (
        <NfceWebFetch
          urls={listConsultUrls(webUrl, key)}
          onHtml={(html) => {
            setWebUrl(null);
            (async () => {
              try {
                const res = await services.nfce.processItems(key, html);
                showToast(`Itens processados: ${res.items} · ${res.appliedToStock} ao estoque · ${res.needsReview} para revisão`);
                bump();
                await load();
              } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), 'err');
              } finally {
                setBusy(false);
              }
            })();
          }}
          onError={(message) => {
            setWebUrl(null);
            setBusy(false);
            showToast(message, 'err');
          }}
        />
      ) : null}

      {!webUrl && doc ? (
        <Card>
          <KeyValue k="Estabelecimento" v={doc.store_name ?? 'Não identificado'} bold />
          <KeyValue k="CNPJ" v={doc.cnpj ?? '—'} />
          <KeyValue k="Valor pago" v={doc.amount_paid_cents != null ? formatBRL(doc.amount_paid_cents) : '—'} />
          <KeyValue k="Emissão" v={doc.issued_at ? ymdToBr(doc.issued_at.slice(0, 10)) : '—'} />
          <View className="flex-row gap-2 mt-1">
            <Badge status={doc.parse_status} />
            {doc.needs_review ? <Badge status="REVIEW" /> : null}
          </View>
        </Card>
      ) : null}

      {!webUrl ? (
        <>
          <View className="flex-row gap-2">
            <View className="flex-1"><Button label="Processar itens" variant="outline" onPress={process} loading={busy} /></View>
            <View className="flex-1"><Button label="Aplicar ao estoque" variant="outline" onPress={applyAll} /></View>
          </View>
          <Button label="Buscar página oficial de novo (navegador interno)" variant="outline" onPress={recapture} loading={busy} />
        </>
      ) : null}

      {!webUrl && items.length === 0 ? (
        <Button label="Compartilhar página capturada (diagnóstico)" variant="outline" onPress={shareCaptured} />
      ) : null}

      <SectionTitle>Itens ({items.length})</SectionTitle>
      {items.length === 0 ? (
        <EmptyState icon="🧾" title="Nenhum item processado" hint="Toque em Processar itens para buscar na página da SEFAZ." />
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
              {/* v18 (bug 6): qtde, unidade e código do produto sempre visíveis */}
              <Text className="text-xs text-slate-500 mt-0.5">
                Qtde: {item.qty ?? '—'} {item.unit_original ?? ''} · Un: {item.unit_original ?? '—'}
              </Text>
              {/* v59: SEM EAN na tela — o usuário não sabe o que é EAN olhando a NF.
                  O EAN continua sendo aprendido sozinho por dentro (resolveOrRegister). */}
              {item.store_product_code ? (<Text className="text-xs text-slate-500">Código: {item.store_product_code}</Text>) : null}
              <Text className="text-xs font-semibold text-slate-600">
                {item.total_cents != null ? formatBRL(item.total_cents) : '—'}
              </Text>
              <View className="flex-row flex-wrap items-center gap-1 mt-1">
                <Text className="text-[10px] text-slate-500 bg-slate-50 px-1.5 py-0.5 rounded">
                  {item.product_name ? `→ ${item.product_name}` : 'produto não vinculado'}
                </Text>
                {mb ? (
                  <Text className={`text-[10px] px-1.5 py-0.5 rounded ${badgeToneCls[mb.tone]}`}>{mb.text}</Text>
                ) : null}
                {item.stock_applied ? (
                  <Text className="text-[10px] text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">no estoque</Text>
                ) : null}
                {unitClash ? (
                  <Text className="text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
                    {itemDim} ≠ {item.product_base_unit} — fora do estoque
                  </Text>
                ) : null}
                {item.status === 'IGNORED' ? <Text className="text-[10px] text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">ignorado</Text> : null}
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
              <Text className="text-[10px] text-amber-700">
                "Sempre" grava a memória NUNCA: as próximas notas deste produto nem perguntam.
              </Text>
            </View>
          ) : null}

          {/* v67 (MELHORIA 1) — AÇÕES GUIADAS do item, na ordem da tabela da verdade:
              fuzzy → "É esse / É outro / + Produto novo / Ignorar"; sem produto →
              "É outro (vincular) / + Produto novo / Ignorar"; com produto e sem
              estoque → pergunta "Incluir no estoque?" */}
          {item.status !== 'IGNORED' && linkingId !== item.id && creatingId !== item.id && stockAskId !== item.id ? (
            <View className="flex-row flex-wrap gap-1.5 mt-2">
              {item.match_type === 'FUZZY' && item.product_id ? (
                <>
                  <MiniAction label={`É esse (${item.match_score != null ? Math.round(item.match_score * 100) : '?'}%)`} onPress={() => confirmFuzzy(item)} tone="primary" />
                  <MiniAction label="É outro" onPress={() => openLinker(item)} />
                  <MiniAction label="+ Produto novo" onPress={() => { setCreatingId(item.id); setNewCatId(null); }} />
                  <MiniAction label="Ignorar" onPress={() => ignore(item)} tone="muted" />
                </>
              ) : !item.product_id ? (
                <>
                  <MiniAction label="É outro (vincular produto)" onPress={() => openLinker(item)} tone="primary" />
                  <MiniAction label="+ Produto novo" onPress={() => { setCreatingId(item.id); setNewCatId(null); }} tone="primary" />
                  <MiniAction label="Ignorar" onPress={() => ignore(item)} tone="muted" />
                </>
              ) : !item.stock_applied ? (
                <MiniAction label="Incluir no estoque?" onPress={() => setStockAskId(item.id)} tone="primary" />
              ) : null}
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
            className={`text-[11px] px-2 py-1 rounded-full ${
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
