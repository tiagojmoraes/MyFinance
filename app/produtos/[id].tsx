/**
 * ProdutO (v100 — FORMULÁRIO ÚNICO):
 *  · /produtos/novo → cadastra um produto novo (manual OU a partir de um item
 *    de NF pendente via `?pending=...`);
 *  · /produtos/ID → edita (nome com ` • ` gerado pelo sistema — o usuário
 *    digita só conteúdo), categoria ▸ subcategoria, Com/Sem controle, mínimo,
 *    unidade, status Ativo/Inativo;
 *  · inativar BLOQUEIA com saldo > 0;
 *  · o mesmo formulário serve para NF + manual + edição;
 *  · v8 — na CRIAÇÃO, ao digitar o nome, mostra até 3 produtos semelhantes
 *    do catálogo (só sugestão; tocar usa o existente — com `?pending=`,
 *    vincula o item da NF em vez de criar outro produto).
 */
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { showToast } from '../../src/lib/toast';
import { Screen, Card, TextField, Select, Segmented, Button } from '../../src/components/ui';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { useDataEffect } from '../../src/components/useDataEffect';
import { useAppStore } from '../../src/store/appStore';
import { ICONS } from '../../src/theme/icons';
import { theme } from '../../src/theme';
import { displayProductName, productKey } from '../../src/lib/productName';
import { parseKgToGrams, gramsToKgText } from '../../src/lib/money';

type StockControl = 0 | 1;
type Status = 'ATIVO' | 'INATIVO';
type BaseUnit = 'G' | 'ML' | 'UN';

interface ProductRow {
  id: string;
  ean: string | null;
  name: string;
  category_id: string | null;
  base_unit: BaseUnit | null;
  stock_control: number | null;
  status: string | null;
}
interface CategoryRow { id: string; name: string; parent_id: string | null; archived_at: string | null; }
interface PendingInput {
  description?: string; cnpj?: string | null; storeName?: string | null;
  storeProductCode?: string | null; itemId?: string;
}
/** v8 — sugestão de produto existente (só na criação). */
interface Suggestion { id: string; name: string; score: number }

export default function ProdutoEditScreen() {
  const params = useLocalSearchParams<{ id?: string; pending?: string }>();
  const isNew = params.id === 'novo';
  const pending: PendingInput | null = React.useMemo(() => {
    if (!params.pending) return null;
    try { return JSON.parse(params.pending); } catch { return null; }
  }, [params.pending]);
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [loaded, setLoaded] = React.useState(isNew);
  const [name, setNameRaw] = React.useState(pending?.description ?? '');
  // O usuário NUNCA digita bullet — a tela renderiza com bullet pelo displayName().
  const setName = (v: string) => setNameRaw(v.replace(/\u2022/g, ' '));
  const [ean, setEan] = React.useState('');
  const [categoryId, setCategoryId] = React.useState<string | null>(null);
  const [subcategoryId, setSubcategoryId] = React.useState<string | null>(null);
  const [baseUnit, setBaseUnit] = React.useState<BaseUnit>('UN');
  const [stockControl, setStockControl] = React.useState<StockControl>(1);
  const [threshold, setThreshold] = React.useState('');
  const [status, setStatus] = React.useState<Status>('ATIVO');
  const [saving, setSaving] = React.useState(false);
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);
  const [productName, setProductName] = React.useState('');
  const [categories, setCategories] = React.useState<CategoryRow[]>([]);
  // v8 — sugestões por semelhança: SÓ na criação (nunca na edição).
  const [suggestions, setSuggestions] = React.useState<Suggestion[]>([]);
  const suggestionCache = React.useRef(new Map<string, Suggestion[]>());
  // v103: EAN só vem da NF quando o form nasceu de um pendente (o usuário NÃO digita EAN).
  // Pré-preenchido UMA vez na abertura; permanece durante a edição da tela.
  const [pendingEan, setPendingEan] = React.useState<string | null>(null);
  // v103: unidade ORIGINAL do produto (edição) — base_unit 'ML' (legado) só aparece
  // como opção se o produto carregado já tinha 'ML'. Serve para a lista de opções.
  const [originalBaseUnit, setOriginalBaseUnit] = React.useState<BaseUnit | null>(null);

  // Carrega categorias
  React.useEffect(() => {
    services.categories.listActive().then((cats) => setCategories(cats as unknown as CategoryRow[]));
  }, [services]);
  // Carrega o produto (edição)
  useDataEffect(async (svc) => {
    if (isNew) { setLoaded(true); return; }
    const row = await svc.db.getFirstAsync<ProductRow>(
      'SELECT id, ean, name, category_id, base_unit, stock_control, status FROM products_catalog WHERE id = ?',
      [params.id ?? '']
    );
    if (row) {
      const cats = (await svc.categories.listActive()) as unknown as CategoryRow[];
      setCategories(cats);
      const split = (id: string | null): { parent: string | null; sub: string | null } => {
        if (!id) return { parent: null, sub: null };
        const r = cats.find((c) => c.id === id);
        if (!r) return { parent: id, sub: null };
        if (r.parent_id) return { parent: r.parent_id, sub: r.id };
        return { parent: r.id, sub: null };
      };
      const sp = split(row.category_id);
      setNameRaw((row.name ?? '').replace(/\u2022/g, ' '));
      setProductName(row.name ?? '');
      setEan(row.ean ?? '');
      setCategoryId(sp.parent);
      setSubcategoryId(sp.sub);
      setBaseUnit((row.base_unit as BaseUnit) ?? 'UN');
      setStockControl(((row.stock_control ?? 1) as StockControl));
      setStatus((row.status as Status) ?? 'ATIVO');
      // v103: guarda a unidade ORIGINAL do produto — ML só aparece como opção se o
      // carregado já era ML (produto legado).
      setOriginalBaseUnit((row.base_unit as BaseUnit) ?? null);
      const stockRow = await svc.db.getFirstAsync<{ low_threshold_base: number | null }>(
        'SELECT low_threshold_base FROM pantry_stock WHERE product_id = ?',
        [row.id]
      );
      // v103: edição — converte GRAMAS→kg para preencher o campo se a unidade é KG.
      if (row.base_unit === 'G') {
        setThreshold(gramsToKgText(stockRow?.low_threshold_base ?? null));
      } else {
        setThreshold(stockRow?.low_threshold_base != null ? String(stockRow.low_threshold_base) : '');
      }
    }
    setLoaded(true);
  });

  // v8 — compara o nome digitado com o catálogo (debounce 250 ms + cache por
  // nome). Sem sugestão acima do limiar: nada aparece (sem aviso).
  React.useEffect(() => {
    if (!isNew) { setSuggestions([]); return; }
    const typed = name.trim();
    if (typed.length < 3) { setSuggestions([]); return; }
    const key = productKey(typed);
    const cached = suggestionCache.current.get(key);
    if (cached) { setSuggestions(cached); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const found = await services.products.suggestTop3(typed, { limit: 3, excludeId: params.id ?? null });
        if (!alive) return;
        const list: Suggestion[] = found.map((s) => ({ id: s.product.id, name: s.product.name, score: s.score }));
        suggestionCache.current.set(key, list);
        setSuggestions(list);
      } catch {
        if (alive) setSuggestions([]);
      }
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [name, isNew, services, params.id]);

  /**
   * v103 — PRÉ-PREENCHIMENTO a partir do item pendente da NF (apenas na
   * CRIAÇÃO, uma única vez na abertura). SEM loop: UMA consulta para o EAN
   * e UMA para a categoria herdada, em paralelo.
   *  · Categoria: (1) transactions.category_id pelo itemId → access_key →
   *    transaction_id; (2) senão, nfce_store_categories pelo cnpj do item.
   *    Se for subcategoria (category pai preenchida), separa pai/filha.
   *  · EAN: lê nfce_items.ean_extracted; se for só dígitos com 8, 12, 13 ou
   *    14 posições E nenhum produto já tiver esse EAN, pré-preenche.
   *  · NÃO sobrescreve escolha do usuário: setCategoryId/setSubcategoryId
   *    só preenchem se o estado ainda for null.
   */
  React.useEffect(() => {
    if (!isNew || !pending) return;
    let alive = true;
    (async () => {
      try {
        // Garante categorias ATIVAS para o split pai/filha.
        let cats = categories;
        if (cats.length === 0) {
          cats = (await services.categories.listActive()) as unknown as CategoryRow[];
          if (cats.length > 0 && alive) setCategories(cats);
        }
        if (!alive) return;

        // EAN do item pendente (nunca vem do TextField — campo foi removido).
        if (pending.itemId) {
          const itm = await services.db.getFirstAsync<{ ean_extracted: string | null }>(
            'SELECT ean_extracted FROM nfce_items WHERE id = ?',
            [pending.itemId]
          );
          const raw = itm?.ean_extracted ?? null;
          if (raw && /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(raw)) {
            const dup = await services.db.getFirstAsync<{ id: string }>(
              'SELECT id FROM products_catalog WHERE ean = ? LIMIT 1',
              [raw]
            );
            if (!dup && alive) setPendingEan(raw);
          }
        }

        // Categoria herdada.
        let catId: string | null = null;
        if (pending.itemId) {
          const r = await services.db.getFirstAsync<{ category_id: string | null }>(
            `SELECT t.category_id
               FROM nfce_items ni
               JOIN nfce_documents d ON d.access_key = ni.access_key
               LEFT JOIN transactions t ON t.id = d.transaction_id
              WHERE ni.id = ?`,
            [pending.itemId]
          );
          if (r?.category_id) catId = r.category_id;
        }
        if (!catId && pending.cnpj) {
          const r = await services.db.getFirstAsync<{ category_id: string | null }>(
            'SELECT category_id FROM nfce_store_categories WHERE cnpj = ?',
            [pending.cnpj]
          );
          if (r?.category_id) catId = r.category_id;
        }
        if (!alive || !catId) return;
        const c = cats.find((x) => x.id === catId);
        if (!c || c.archived_at) return; // arquivada: vazio (como hoje).
        if (c.parent_id) {
          setCategoryId((cur) => cur ?? c.parent_id);
          setSubcategoryId((cur) => cur ?? catId);
        } else {
          setCategoryId((cur) => cur ?? catId);
        }
      } catch {
        // silencioso: sem categoria herdada continua como hoje.
      }
    })();
    return () => { alive = false; };
  }, [isNew, pending, services]);

  /** v8 — tocar na sugestão: pendente da NF → vincula e volta; criação manual → edita o existente. */
  const applySuggestion = async (productId: string) => {
    if (pending) {
      try {
        await services.nfce.classifyPendingBatch({
          cnpj: pending.cnpj ?? null,
          storeProductCode: pending.storeProductCode ?? null,
          productId,
        });
        showToast('Vinculado ao produto existente');
        bump();
        router.back();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'err');
      }
      return;
    }
    router.replace(`/produtos/${productId}`);
  };

  const save = async () => {
    if (!name.trim()) { showToast('Informe o nome do produto', 'err'); return; }
    setSaving(true);
    try {
      const finalCategoryId = subcategoryId ?? categoryId;
      // v103: mínimo em KG quando unidade = Kilos; senão inteiro na unidade.
      const th = baseUnit === 'G' ? parseKgToGrams(threshold) : parseInt(threshold, 10);
      const thValid = baseUnit === 'G' ? Number.isFinite(th) : Number.isInteger(th);
      let productId: string;
      if (isNew) {
        const created = await services.products.createManualProduct({
          name: name.trim(),
          // v103: EAN do item pendente (pré-preenchido) OU null; o usuário não digita.
          ean: pendingEan ?? null,
          baseUnit, categoryId: finalCategoryId,
          pantryPolicy: stockControl ? 'ALWAYS' : 'NEVER',
          stockControl,
        });
        productId = created.id;
        if (pending?.itemId && pending?.cnpj && pending?.storeProductCode) {
          // Cria a amarração do item pendente (1 toque depois de criar o produto)
          try {
            await services.nfce.classifyPendingBatch({
              cnpj: pending.cnpj, storeProductCode: pending.storeProductCode, productId,
            });
          } catch {}
        }
      } else {
        await services.products.updateProduct(params.id!, {
          name: name.trim(),
          // v103: edição — preserva o EAN carregado (campo removido da tela);
          // null se o produto original não tinha EAN.
          ean: ean.trim() ? ean.trim() : null,
          baseUnit, categoryId: finalCategoryId, stockControl, status,
        });
        await services.pantry.setLowThreshold(params.id!, thValid ? th : null);
        productId = params.id!;
      }
      if (!isNew) {
        // setLowThreshold pode falhar — aplicado dentro do save() acima para !isNew
      }
      bump();
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    try {
      await services.products.removeCatalogProduct(params.id!);
      showToast(`"${productName}" saiu do catálogo (notas e lançamentos preservados)`);
      setDeleteConfirm(false);
      bump();
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  const tryInactivate = async () => {
    if (!isNew) {
      try {
        await services.products.setStatus(params.id!, 'INATIVO');
        setStatus('INATIVO');
        showToast('Produto inativado — não entra em estoque nem na Lista de Compra.');
        bump();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'err');
      }
    }
  };

  const parents = categories.filter((c) => !c.parent_id);
  const subs = categoryId ? categories.filter((c) => c.parent_id === categoryId) : [];

  return (
    <Screen title={isNew ? (pending ? 'Classificar Produto' : 'Novo produto') : 'Editar produto'}>
      {!loaded ? (
        <Card><Text className="text-slate-500">Carregando...</Text></Card>
      ) : (
        <Card className="gap-3">
          {pending && (
            <View className="bg-amber-50 p-3 rounded-lg">
              <Text className="text-xs text-amber-800 font-bold">Veio da NF — classificar 1 vez</Text>
            </View>
          )}

          <TextField label="Nome" value={name} onChangeText={setName} placeholder="Ex.: Café" />
          {isNew && suggestions.length > 0 ? (
            <View className="gap-1">
              <Text className="text-xs text-slate-500">Já existe no catálogo — toque para usar:</Text>
              {suggestions.map((s) => (
                <Pressable key={s.id} onPress={() => applySuggestion(s.id)} accessibilityRole="button"
                  accessibilityLabel={`Usar ${s.name}`} className="bg-emerald-50 px-3 py-2 rounded-lg">
                  <Text className="text-emerald-900 font-medium">
                    {displayProductName(s.name)} · {Math.round(s.score * 100)}%
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {isNew && pendingEan ? (
            <View className="bg-slate-50 rounded-lg p-2">
              <Text className="text-xs text-slate-500">EAN DA NF</Text>
              <Text className="font-medium text-slate-900">{pendingEan}</Text>
            </View>
          ) : null}

          <Select
            label="Categoria"
            items={parents.map((c) => ({ id: c.id, label: c.name }))}
            selectedId={categoryId}
            onSelect={(id) => { setCategoryId(id); setSubcategoryId(null); }}
            allowEmpty
            emptyLabel="Sem categoria"
          />
          <Select
            label="Subcategoria (opcional)"
            items={subs.map((c) => ({ id: c.id, label: c.name }))}
            selectedId={subcategoryId}
            onSelect={setSubcategoryId}
            allowEmpty
            emptyLabel="Sem subcategoria"
          />

          <Text className={`text-sm font-medium ${theme.textMuted}`}>Unidade Medida</Text>
          <Segmented<BaseUnit> options={(() => {
            const opts: Array<{ value: BaseUnit; label: string }> = [
              { value: 'UN', label: 'Unidade' },
              { value: 'G', label: 'Kilos' },
            ];
            // v103: ML só aparece para edições de produtos legados (criação nunca).
            if (!isNew && originalBaseUnit === 'ML') {
              opts.push({ value: 'ML', label: 'Mililitros' });
            }
            return opts;
          })()} value={baseUnit} onChange={setBaseUnit} />

          <Text className={`text-sm font-medium ${theme.textMuted}`}>Controle de estoque</Text>
          <Segmented<'YES' | 'NO'> options={[
            { value: 'YES', label: 'Com controle' },
            { value: 'NO', label: 'Sem controle' },
          ]} value={stockControl === 1 ? 'YES' : 'NO'} onChange={(v) => setStockControl(v === 'YES' ? 1 : 0)} />
          {stockControl === 1 ? (
            <TextField
              label={
                baseUnit === 'G' ? 'Estoque mínimo (kg)'
                : baseUnit === 'UN' ? 'Estoque mínimo (un)'
                : 'Estoque mínimo (na unidade de medida)'
              }
              value={threshold}
              onChangeText={setThreshold}
              keyboardType={(baseUnit === 'G' ? 'decimal-pad' : 'numeric') as 'decimal-pad' | 'numeric'}
              placeholder={baseUnit === 'G' ? 'Ex.: 0,5' : 'Ex.: 500'}
            />
          ) : null}

          {!isNew ? (
            <>
              <Text className={`text-sm font-medium ${theme.textMuted}`}>Status</Text>
              <Segmented<Status> options={[
                { value: 'ATIVO' as Status, label: 'Ativo' },
                { value: 'INATIVO' as Status, label: 'Inativo' },
              ]} value={status} onChange={(v) => {
                if (v === 'INATIVO') {
                  tryInactivate();
                } else {
                  setStatus('ATIVO');
                }
              }} />
              <Text className="text-xs text-slate-400">Para inativar com saldo &gt; 0, zere o estoque na Despensa antes (a tela bloqueia).</Text>
            </>
          ) : null}

          <Button label={isNew ? (suggestions.length > 0 ? 'Criar mesmo assim' : 'Cadastrar produto') : 'Salvar alterações'} onPress={save} loading={saving} />

          {!isNew ? (
            <Button label={`${ICONS.excluir} Excluir do catálogo`} variant="outline" onPress={() => setDeleteConfirm(true)} />
          ) : null}
        </Card>
      )}

      <ConfirmDialog
        visible={deleteConfirm}
        title="Excluir do catálogo?"
        message={`"${productName}" sai do catálogo e o estoque dele é zerado. As NOTAS e os LANÇAMENTOS não são apagados — os itens das notas só perdem o vínculo. A próxima nota pode reaprender o produto.`}
        buttons={[
          { label: 'Excluir do catálogo', color: 'red', onPress: doDelete },
          { label: 'Cancelar', color: 'green', onPress: () => setDeleteConfirm(false) },
        ]}
        onClose={() => setDeleteConfirm(false)}
      />
    </Screen>
  );
}
