/**
 * ProdutO (v100 — FORMULÁRIO ÚNICO):
 *  · /produtos/novo → cadastra um produto novo (manual OU a partir de um item
 *    de NF pendente via `?pending=...`);
 *  · /produtos/ID → edita (nome com ` • ` gerado pelo sistema — o usuário
 *    digita só conteúdo), categoria ▸ subcategoria, Com/Sem controle, mínimo,
 *    unidade, status Ativo/Inativo (e "Não é produto");
 *  · inativar BLOQUEIA com saldo > 0;
 *  · o mesmo formulário serve para NF + manual + edição.
 */
import React from 'react';
import { View, Text } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { showToast } from '../../src/lib/toast';
import { Screen, Card, TextField, Select, Segmented, Button } from '../../src/components/ui';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { useDataEffect } from '../../src/components/useDataEffect';
import { useAppStore } from '../../src/store/appStore';
import { ICONS } from '../../src/theme/icons';
import { theme } from '../../src/theme';
import { displayProductName } from '../../src/lib/productName';

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
      const stockRow = await svc.db.getFirstAsync<{ low_threshold_base: number | null }>(
        'SELECT low_threshold_base FROM pantry_stock WHERE product_id = ?',
        [row.id]
      );
      setThreshold(stockRow?.low_threshold_base != null ? String(stockRow.low_threshold_base) : '');
    }
    setLoaded(true);
  });

  const save = async () => {
    if (!name.trim()) { showToast('Informe o nome do produto', 'err'); return; }
    setSaving(true);
    try {
      const finalCategoryId = subcategoryId ?? categoryId;
      const th = parseInt(threshold, 10);
      let productId: string;
      if (isNew) {
        const created = await services.products.createManualProduct({
          name: name.trim(), ean: ean.trim() ? ean.trim() : null,
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
          name: name.trim(), ean: ean.trim() ? ean.trim() : null,
          baseUnit, categoryId: finalCategoryId, stockControl, status,
        });
        await services.pantry.setLowThreshold(params.id!, Number.isInteger(th) ? th : null);
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

  const onIgnorePending = async () => {
    if (pending?.cnpj && pending?.storeProductCode) {
      try {
        await services.nfce.ignorePendingBatch({ cnpj: pending.cnpj, storeProductCode: pending.storeProductCode });
        showToast('Marcado como "não é produto" — não pergunta mais.');
        bump();
        router.back();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'err');
      }
    }
  };

  const parents = categories.filter((c) => !c.parent_id);
  const subs = categoryId ? categories.filter((c) => c.parent_id === categoryId) : [];
  const preview = displayProductName(name);

  return (
    <Screen title={isNew ? (pending ? 'Classificar produto (da NF)' : 'Novo produto') : 'Editar produto'}>
      {!loaded ? (
        <Card><Text className="text-slate-500">Carregando...</Text></Card>
      ) : (
        <Card className="gap-3">
          {pending && (
            <View className="bg-amber-50 p-3 rounded-lg">
              <Text className="text-xs text-amber-800 font-bold">Veio da NF — classificar 1 vez</Text>
              <Text className="text-[11px] text-amber-700 mt-1">
                A decisão grava a amarração (CNPJ + código) — as próximas notas desta loja já resolvem sozinhas (zero interação).
              </Text>
            </View>
          )}

          <TextField label="Nome" value={name} onChangeText={setName} placeholder="Ex.: Café" />
          <View className="bg-slate-50 rounded-lg p-2">
            <Text className="text-[10px] text-slate-500">EXIBIÇÃO (com bullet •)</Text>
            <Text className="font-medium text-slate-900">{preview || '—'}</Text>
          </View>

          <TextField label="EAN / GTIN (opcional)" value={ean} onChangeText={setEan} keyboardType="numeric" placeholder="789..." />

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

          <Text className={`text-sm font-medium ${theme.textMuted}`}>Unidade base</Text>
          <Segmented<BaseUnit> options={[
            { value: 'UN', label: 'Unidade' },
            { value: 'G', label: 'Gramas' },
            { value: 'ML', label: 'Mililitros' },
          ]} value={baseUnit} onChange={setBaseUnit} />

          <Text className={`text-sm font-medium ${theme.textMuted}`}>Controle de estoque</Text>
          <Segmented<'YES' | 'NO'> options={[
            { value: 'YES', label: 'Com controle' },
            { value: 'NO', label: 'Sem controle' },
          ]} value={stockControl === 1 ? 'YES' : 'NO'} onChange={(v) => setStockControl(v === 'YES' ? 1 : 0)} />
          {stockControl === 1 ? (
            <TextField label="Estoque mínimo (na unidade base)" value={threshold} onChangeText={setThreshold} keyboardType="numeric" placeholder="Ex.: 500" />
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
              <Text className="text-[11px] text-slate-400">Para inativar com saldo &gt; 0, zere o estoque na Despensa antes (a tela bloqueia).</Text>
            </>
          ) : null}

          <Button label={isNew ? 'Cadastrar produto' : 'Salvar alterações'} onPress={save} loading={saving} />

          {pending ? (
            <Button label="Não é produto — nunca mais" variant="outline" onPress={onIgnorePending} />
          ) : null}

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
