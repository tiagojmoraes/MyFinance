/**
 * Catálogo de Produto (v101 — CARROSSEL de 4 abas):
 *  · "Pendentes de classificação" (NF sem decisão do usuário): o que
 *    precisa ser tocado/classificado;
 *  · "Classificado › Com Estoque": stock_control=1 + ativo (decisão do
 *    usuário → vai para a Despensa Estoque);
 *  · "Classificado › Sem Estoque": stock_control=0 + ativo (decisão do
 *    usuário → vai para a Lista de Compra);
 *  · "Inativo | Excluído": status=INATIVO ou removidos do catálogo.
 * AUTO-NFCE só aparece em "Pendentes" — a regra é "só após a definição
 * do Catálogo", então enquanto o usuário não classificar, o produto não
 * entra em Despensa nem em Lista de Compra.
 */
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, TextField, Button, EmptyState, Segmented } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { ICONS } from '../src/theme/icons';
import { theme } from '../src/theme';
import { displayProductName } from '../src/lib/productName';
import { showToast } from '../src/lib/toast';
import { formatStockQty } from '../src/lib/money';

interface PendingGroup {
  groupKey: string;
  cnpj: string | null;
  storeName: string | null;
  storeProductCode: string | null;
  sampleDescription: string;
  n: number;
  sampleItemId: string;
}
interface ProductRow {
  id: string;
  ean: string | null;
  name: string;
  category_id: string | null;
  base_unit: 'G' | 'ML' | 'UN' | null;
  pantry_policy?: 'ALWAYS' | 'ASK' | 'NEVER' | null;
  stock_control?: number | null;
  status?: 'ATIVO' | 'INATIVO' | null;
  /** v101 — origem do produto. 'USER' = decidido pelo usuário (Catálogo/
   *  Revisão). 'NFCE' = AUTO-criado na leitura — NUNCA entra em Despensa/
   *  Lista até o usuário classificar. */
  origin?: 'USER' | 'NFCE' | null;
}
interface CategoryRow { id: string; name: string; parent_id: string | null; archived_at: string | null; }
interface PantryRow { product_id: string; quantity_base: number; base_unit?: string | null; low_threshold_base?: number | null; }
/** v102 — regra persistida em `nfce_item_ignores` (catálogo Inativo|Excluído). */
interface IgnoredRule {
  id: string;
  cnpj: string | null;
  ean: string | null;
  store_product_code: string | null;
  description_norm: string;
  created_at: string | null;
  store_name: string | null;
}

type Tab = 'PENDENTES' | 'CLASSIFICADOS' | 'INATIVO';

/** Rótulo curto da unidade para o cartão do produto. */
function unitLabelOf(u: 'G' | 'ML' | 'UN' | null | undefined): string {
  if (u === 'G') return 'Kilos';
  if (u === 'ML') return 'Mililitros (legado)';
  return 'Unidade';
}

export default function ProdutosScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [products, setProducts] = React.useState<ProductRow[]>([]);
  const [pending, setPending] = React.useState<PendingGroup[]>([]);
  const [categories, setCategories] = React.useState<CategoryRow[]>([]);
  const [pantry, setPantry] = React.useState<PantryRow[]>([]);
  const [ignoredRules, setIgnoredRules] = React.useState<IgnoredRule[]>([]);
  const [search, setSearch] = React.useState('');
  // v103: 3 abas — começa nos Pendentes se houver; senão em Classificados.
  const [tab, setTab] = React.useState<Tab>('PENDENTES');
  // v103: vira true quando a 1ª carga dos pendentes termina — usado para
  // saltarmos direto para "Classificados" se nada estiver pendente.
  const [pendingLoaded, setPendingLoaded] = React.useState(false);
  // v106: sub-seletor da aba CLASSIFICADOS (Com Estoque / Sem Estoque).
  const [classTab, setClassTab] = React.useState<'COM' | 'SEM'>('COM');

  // useDataEffect provides dataVersion trigger via appStore.bump().
  // We fetch on mount and on data version changes.
  React.useEffect(() => {
    const load = async () => {
      const [plist, clist, pantryList, pend, rules] = await Promise.all([
        services.products.listProducts(500),
        services.categories.listActive(),
        services.pantry.listPantry(),
        services.nfce.listPendingItems(),
        services.nfce.listIgnoredRules(),
      ]);
      setProducts(plist as unknown as ProductRow[]);
      setCategories(clist as unknown as CategoryRow[]);
      setPantry(pantryList as unknown as PantryRow[]);
      setPending(pend as unknown as PendingGroup[]);
      setIgnoredRules(rules as unknown as IgnoredRule[]);
      setPendingLoaded(true);
    };
    void load();
  }, [services]);
  // Buscar subscribe to data version
  useDataEffect(async (svc) => {
    const [plist, clist, pantryList, pend, rules] = await Promise.all([
      svc.products.listProducts(500),
      svc.categories.listActive(),
      svc.pantry.listPantry(),
      svc.nfce.listPendingItems(),
      svc.nfce.listIgnoredRules(),
    ]);
    setProducts(plist as unknown as ProductRow[]);
    setCategories(clist as unknown as CategoryRow[]);
    setPantry(pantryList as unknown as PantryRow[]);
    setPending(pend as unknown as PendingGroup[]);
    setIgnoredRules(rules as unknown as IgnoredRule[]);
    setPendingLoaded(true);
  });

  const categoryLabelOf = React.useCallback((p: ProductRow): string => {
    if (!p.category_id) return 'Sem categoria';
    const row = categories.find((c) => c.id === p.category_id);
    if (!row) return 'Sem categoria';
    if (row.parent_id) {
      const parent = categories.find((c) => c.id === row.parent_id);
      return parent ? `${parent.name} › ${row.name}` : row.name;
    }
    return row.name;
  }, [categories]);

  const stockLabelOf = React.useCallback((p: ProductRow): string => {
    if (!p.stock_control) return 'Sem controle';
    const s = pantry.find((x) => x.product_id === p.id);
    const q = s?.quantity_base ?? 0;
    const unit = s?.base_unit ?? p.base_unit;
    return formatStockQty(unit, q);
  }, [pantry]);

  // v103: 3 abas. CLASSIFICADOS reúne COM/SEM estoque — a separação é só visual.
  // A regra da aba é só pelos campos do próprio produto (decisão do usuário):
  // origin='USER' + status + stock_control. SEM query em loop: tudo em memória.
  const classifiedProdutos = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (p: ProductRow): boolean => (q ? p.name.toLowerCase().includes(q) : true);
    const ativo = (p: ProductRow): boolean => (p.status ?? 'ATIVO') === 'ATIVO';
    const userDecided = (p: ProductRow): boolean => (p.origin ?? 'NFCE') === 'USER';
    const list = products
      .filter((p) => userDecided(p) && ativo(p) && match(p))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return {
      comEstoque: list.filter((p) => (p.stock_control ?? 0) === 1),
      semEstoque: list.filter((p) => (p.stock_control ?? 0) === 0),
    };
  }, [products, search]);

  const filteredByTab = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (p: ProductRow): boolean => (q ? p.name.toLowerCase().includes(q) : true);
    return {
      INATIVO: products.filter((p) => ((p.status ?? 'ATIVO') === 'INATIVO') && match(p)),
    };
  }, [products, search]);

  // v102 — regras ignoradas filtradas pela busca (descrição e loja).
  const ignoredFiltered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ignoredRules;
    return ignoredRules.filter((r) =>
      r.description_norm.includes(q) || (r.store_name ?? '').toLowerCase().includes(q)
    );
  }, [ignoredRules, search]);

  // Render
  const tabOptions: Array<{ value: Tab; label: string }> = [
    { value: 'PENDENTES', label: `Pendentes (${pending.length})` },
    { value: 'CLASSIFICADOS', label: `Classificados (${classifiedProdutos.comEstoque.length + classifiedProdutos.semEstoque.length})` },
    { value: 'INATIVO', label: `Inativo|Excluído (${filteredByTab.INATIVO.length + ignoredFiltered.length})` },
  ];
  // v103: aba inicial — pula para CLASSIFICADOS se NÃO houver pendência
  // (ao abrir com catálogo já todo classificado, sem precisar de 1 toque).
  React.useEffect(() => {
    if (tab === 'PENDENTES' && pendingLoaded && pending.length === 0) {
      setTab('CLASSIFICADOS');
    }
  }, [pendingLoaded, pending.length, tab]);
  return (
    <Screen title="Catálogo de Produto">
      {/* v103 — CARROSSEL: 3 abas Segmented. */}
      <Segmented<Tab> options={tabOptions} value={tab} onChange={setTab} />

      <TextField label="Buscar produto" value={search} onChangeText={setSearch} placeholder="Ex.: Café • Gourmet • 500G" />

      {/* ABA: PENDENTES DE CLASSIFICAÇÃO — itens da NF que o usuário precisa TOCAR. */}
      {tab === 'PENDENTES' ? (
        pending.length === 0 ? (
          <EmptyState icon={ICONS.produtos} title="Nada pendente" hint="Tudo classificado. Os novos itens da NF caem aqui na próxima leitura." />
        ) : (
          <Card className="!py-3 border-amber-300">
            <Text className={`font-bold ${theme.primaryText}`}>Pendentes de classificação ({pending.length})</Text>
            <Text className="text-xs text-slate-500 mt-0.5">
              Toque em "＋ Criar produto" para classificar 1 vez — só então o produto entra na Despensa ou na Lista de Compra.
            </Text>
            <View className="mt-2 gap-2">
              {pending.map((g) => (
                <PendingRow key={g.groupKey} group={g} onCreateNew={() => router.push(`/produtos/novo?pending=${encodeURIComponent(JSON.stringify({
                  description: g.sampleDescription, cnpj: g.cnpj, storeName: g.storeName, storeProductCode: g.storeProductCode, itemId: g.sampleItemId,
                }))}`)} onIgnore={async () => {
                  try { await services.nfce.ignorePendingBatch({ cnpj: g.cnpj, storeProductCode: g.storeProductCode });bump(); }
                  catch (e) { showToast(e instanceof Error ? e.message : String(e), 'err'); }
                }} />
              ))}
            </View>
          </Card>
        )
      ) : tab === 'INATIVO' ? (
        filteredByTab.INATIVO.length === 0 && ignoredFiltered.length === 0 ? (
          <EmptyState
            icon={ICONS.produtos}
            title="Sem inativos ou excluídos"
            hint="Nenhum produto inativo ou ignorado ainda."
          />
        ) : (
          <>
            {filteredByTab.INATIVO.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                categoryLabel={categoryLabelOf(p)}
                stockLabel={stockLabelOf(p)}
                unitLabel={unitLabelOf(p.base_unit)}
              />
            ))}
            {ignoredFiltered.length > 0 ? (
              <Card className="!py-3 border-slate-300 mt-3">
                <Text className={`font-bold ${theme.primaryText}`}>Ignorados da NF (não é produto)</Text>
                <Text className="text-xs text-slate-500 mt-0.5">
                  Toque em "Restaurar" para voltarem a perguntar na próxima nota desta loja.
                </Text>
                <View className="mt-2 gap-2">
                  {ignoredFiltered.map((r) => (
                    <IgnoredRuleRow key={r.id} rule={r} onRestore={async () => {
                      try { await services.nfce.restoreIgnoreRule(r.id);bump(); }
                      catch (e) { showToast(e instanceof Error ? e.message : String(e), 'err'); }
                    }} />
                  ))}
                </View>
              </Card>
            ) : null}
          </>
        )
      ) : tab === 'CLASSIFICADOS' ? (
        // v106 — sub-seletor Com/Sem estoque: o usuário escolhe QUAL lista
        // ver; o totalizador da aba principal segue somando as duas.
        <>
          <Segmented<'COM' | 'SEM'>
            options={[
              { value: 'COM', label: `Com Estoque (${classifiedProdutos.comEstoque.length})` },
              { value: 'SEM', label: `Sem Estoque (${classifiedProdutos.semEstoque.length})` },
            ]}
            value={classTab}
            onChange={setClassTab}
          />
          {classTab === 'COM' ? (
            classifiedProdutos.comEstoque.length === 0 ? (
              <EmptyState
                icon={ICONS.produtos}
                title="Nenhum produto com estoque"
                hint='Ative "Controlar estoque" na edição de um produto classificado para ele aparecer aqui.'
              />
            ) : (
              classifiedProdutos.comEstoque.map((p) => (
                <ProductCard
                  key={p.id}
                  product={p}
                  categoryLabel={categoryLabelOf(p)}
                  stockLabel={stockLabelOf(p)}
                  unitLabel={unitLabelOf(p.base_unit)}
                />
              ))
            )
          ) : classifiedProdutos.semEstoque.length === 0 ? (
            <EmptyState
              icon={ICONS.produtos}
              title="Nenhum produto sem estoque"
              hint='Deixe "Controlar estoque" desligado na edição de um produto classificado para ele aparecer aqui.'
            />
          ) : (
            classifiedProdutos.semEstoque.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                categoryLabel={categoryLabelOf(p)}
                stockLabel={stockLabelOf(p)}
                unitLabel={unitLabelOf(p.base_unit)}
              />
            ))
          )}
        </>
      ) : null}

      <Button label="＋ Novo produto" variant="primary" onPress={() => router.push('/produtos/novo')} />
    </Screen>
  );
}

const ProductCard = React.memo(function ProductCard({ product, categoryLabel, stockLabel, unitLabel }: {
  product: ProductRow;
  categoryLabel: string;
  stockLabel: string;
  unitLabel: string;
}) {
  const inactive = (product.status ?? 'ATIVO') === 'INATIVO';
  const hasStock = (product.stock_control ?? 0) === 1;
  return (
    <Pressable
      onPress={() => router.push(`/produtos/${product.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`Editar ${product.name}`}
    >
      <Card className={inactive ? '!py-3 opacity-60' : '!py-3'}>
        <View className="flex-row justify-between items-start gap-2">
          <View className="flex-1">
            <Text className="font-semibold text-slate-900">{displayProductName(product.name)}</Text>
            <Text className="text-xs text-slate-500 mt-0.5">{categoryLabel}</Text>
            <Text className="text-xs text-slate-500 mt-0.5">
              {unitLabel}{inactive ? ' · Inativo' : ''}
            </Text>
            {hasStock ? (
              <Text className={`text-sm font-bold mt-0.5 ${theme.primaryText}`}>{stockLabel}</Text>
            ) : null}
            <View className="mt-1">
              <View className={`self-start px-2 py-0.5 rounded-full ${hasStock ? 'bg-emerald-50' : 'bg-slate-100'}`}>
                <Text className={`text-xs font-semibold ${hasStock ? 'text-emerald-700' : 'text-slate-600'}`}>
                  {hasStock ? 'Com controle' : 'Sem controle'}
                </Text>
              </View>
            </View>
          </View>
          <Pressable
            onPress={() => router.push(`/produtos/${product.id}`)}
            accessibilityRole="button"
            accessibilityLabel={`Editar ${product.name}`}
            className="bg-amber-50 rounded-lg px-3 py-2"
          >
            <Text className="font-bold text-amber-700">{ICONS.editar}</Text>
          </Pressable>
        </View>
      </Card>
    </Pressable>
  );
});

const PendingRow = React.memo(function PendingRow({ group, onCreateNew, onIgnore }: {
  group: PendingGroup;
  onCreateNew: () => void;
  onIgnore: () => void;
}) {
  const sampleName = displayProductName(group.sampleDescription) || group.sampleDescription || '(sem descrição)';
  return (
    <View className="border border-slate-200 rounded-lg p-3 bg-white">
      <Text className="font-medium text-slate-900">{sampleName}</Text>
      <Text className="text-xs text-slate-500 mt-0.5">
        {group.storeName ?? 'Loja'}{group.storeProductCode ? ` · código ${group.storeProductCode}` : ''} · {group.n} item(ns) desta nota
      </Text>
      <View className="mt-2 flex-row gap-2">
        <Button label="＋ Criar produto" variant="primary" onPress={onCreateNew} />
        <Button label="Não é produto" variant="danger" onPress={onIgnore} />
      </View>
    </View>
  );
});

/** v102 — cartão por regra ignorada (catálogo Inativo|Excluído). */
const IgnoredRuleRow = React.memo(function IgnoredRuleRow({ rule, onRestore }: {
  rule: IgnoredRule;
  onRestore: () => void;
}) {
  const desc = rule.description_norm || '(sem descrição)';
  return (
    <View className="border border-slate-200 rounded-lg p-3 bg-white">
      <Text className="font-medium text-slate-900">{desc}</Text>
      <Text className="text-xs text-slate-500 mt-0.5">
        {rule.store_name ?? 'Loja'}{rule.store_product_code ? ` · código ${rule.store_product_code}` : ''}
      </Text>
      <View className="mt-2 flex-row">
        <Pressable onPress={onRestore} className="bg-emerald-50 px-3 py-2 rounded-lg" accessibilityRole="button">
          <Text className="text-emerald-800 font-medium">Restaurar</Text>
        </Pressable>
      </View>
    </View>
  );
});
