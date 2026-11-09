/**
 * Tela PRODUTO (v68 — MELHORIA Catálogo) — edição/cadastro do produto em TELA
 * PRÓPRIA (antes o formulário abria lá embaixo da lista do Catálogo).
 *  · /produtos/novo → cadastra um produto novo;
 *  · /produtos/ID   → edita o produto (nome, EAN, categoria ▸ subcategoria,
 *    unidade base, política da despensa, alerta de estoque baixo) e EXCLUI
 *    (só desvincula: notas e lançamentos ficam).
 * Mesmo esquema de cores/layout do programa: Screen + Card + TextField +
 * Select + Segmented + Button, tema emerald/slate (src/theme).
 */
import React from 'react';
import { View, Text } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { showToast } from '../../lib/toast';
import { Screen, Card, TextField, Select, Segmented, Button } from '../../src/components/ui';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { useDataEffect } from '../../src/components/useDataEffect';
import { useAppStore } from '../../src/store/appStore';
import { ICONS } from '../../src/theme/icons';
import { theme } from '../../src/theme';

type PantryPolicy = 'ALWAYS' | 'ASK' | 'NEVER';
type BaseUnit = 'G' | 'ML' | 'UN';
type UnitMeasure = 'UN' | 'KG' | 'G';

interface ProductRow {
  id: string;
  ean: string | null;
  name: string;
  category_id: string | null;
  base_unit: BaseUnit | null;
  unit_measure: UnitMeasure;
  pantry_policy?: PantryPolicy | null;
}
interface CategoryRow { id: string; name: string; parent_id: string | null; icon: string | null; archived_at: string | null; }
interface PantryRow { product_id: string; quantity_base: number; base_unit?: string | null; low_threshold_base?: number | null; }

export default function ProdutoEditScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const isNew = params.id === 'novo';
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [loaded, setLoaded] = React.useState(isNew);
  const [name, setName] = React.useState('');
  const [ean, setEan] = React.useState('');
  const [categoryId, setCategoryId] = React.useState<string | null>(null);
  const [subcategoryId, setSubcategoryId] = React.useState<string | null>(null);
  const [baseUnit, setBaseUnit] = React.useState<BaseUnit>('UN');
  const [unitMeasure, setUnitMeasure] = React.useState<UnitMeasure>('UN');
  const [policy, setPolicy] = React.useState<PantryPolicy>('ASK');
  const [threshold, setThreshold] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  // v68: exclusão pela tela de edição (só desvincula — notas/lançamentos ficam)
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);
  const [productName, setProductName] = React.useState('');
  const [categories, setCategories] = React.useState<CategoryRow[]>([]);

  const load = React.useCallback(async (svc: typeof services) => {
    const cats = (await svc.categories.listActive()) as unknown as CategoryRow[];
    setCategories(cats);
    if (isNew) { setLoaded(true); return; }
    const [row, pantryList] = await Promise.all([
      svc.db.getFirstAsync<ProductRow>(
        'SELECT id, ean, name, category_id, base_unit, pantry_policy FROM products_catalog WHERE id = ?',
        [params.id ?? '']
      ),
      svc.pantry.listPantry(),
    ]);
    if (row) {
      const split = (id: string | null): { parent: string | null; sub: string | null } => {
        if (!id) return { parent: null, sub: null };
        const r = cats.find((c) => c.id === id);
        if (!r) return { parent: id, sub: null };
        if (r.parent_id) return { parent: r.parent_id, sub: r.id };
        return { parent: r.id, sub: null };
      };
      const sp = split(row.category_id);
      setName(row.name);
      setProductName(row.name);
      setEan(row.ean ?? '');
      setCategoryId(sp.parent);
      setSubcategoryId(sp.sub);
      setBaseUnit((row.base_unit as BaseUnit) ?? 'UN');
      setUnitMeasure(row.unit_measure ?? (row.base_unit === 'G' ? 'G' : 'UN'));
      setPolicy((row.pantry_policy as PantryPolicy) ?? 'ASK');
      const stock = (pantryList as unknown as PantryRow[]).find((p) => p.product_id === row.id);
      setThreshold(stock?.low_threshold_base != null ? String(stock.low_threshold_base) : '');
    }
    setLoaded(true);
  }, [services, isNew, params.id]);
  useDataEffect(async (svc) => { await load(svc); });

  const save = async () => {
    if (!name.trim()) { showToast('Informe o nome do produto', 'err'); return; }
    setSaving(true);
    try {
      // Subcategoria vale como category_id (é uma categoria com parent_id) — 1 classificação, vale p/ todas as notas.
      const finalCategoryId = subcategoryId ?? categoryId;
      const th = parseInt(threshold, 10);
      if (isNew) {
        const created = await services.products.createManualProduct({
          name: name.trim(), ean: ean.trim() ? ean.trim() : null, baseUnit, unitMeasure, categoryId: finalCategoryId, pantryPolicy: policy,
        });
        await services.pantry.setLowThreshold(created.id, Number.isInteger(th) ? th : null);
      } else {
        await services.products.updateProduct(params.id!, {
          name: name.trim(),
          ean: ean.trim() ? ean.trim() : null,
          baseUnit,
          unitMeasure,
        });
        await services.products.setCategory(params.id!, finalCategoryId);
        await services.products.setPantryPolicy(params.id!, policy);
        await services.pantry.setLowThreshold(params.id!, Number.isInteger(th) ? th : null);
      }
      bump();
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setSaving(false);
    }
  };

  // v68: EXCLUIR do catálogo — SÓ DESVINCULA (notas/lançamentos ficam)
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

  const parents = categories.filter((c) => !c.parent_id);
  const subs = categoryId ? categories.filter((c) => c.parent_id === categoryId) : [];

  return (
    <Screen title={isNew ? 'Novo produto' : 'Editar produto'}>
      {!loaded ? (
        <Card><Text className="text-slate-500">Carregando...</Text></Card>
      ) : (
        <Card className="gap-3">
          <TextField label="Nome" value={name} onChangeText={setName} placeholder="Ex.: Banana Prata" />
          <TextField label="EAN / GTIN (opcional — se vier, ajuda em qualquer loja)" value={ean} onChangeText={setEan} keyboardType="numeric" placeholder="789..." />
          <Select
            label="Categoria"
            items={parents.map((c) => ({ id: c.id, label: `${c.icon ?? ''} ${c.name}`.trim() }))}
            selectedId={categoryId}
            onSelect={(id) => { setCategoryId(id); setSubcategoryId(null); }}
            allowEmpty
            emptyLabel="Sem categoria"
          />
          <Select
            label="Subcategoria"
            items={subs.map((c) => ({ id: c.id, label: `${c.icon ?? ''} ${c.name}`.trim() }))}
            selectedId={subcategoryId}
            onSelect={setSubcategoryId}
            allowEmpty
            emptyLabel="Sem subcategoria"
          />
          <Text className={`text-sm font-medium ${theme.textMuted}`}>Unidade de medida</Text>
          <Segmented<UnitMeasure>
            options={[
              { value: 'UN', label: 'Unidade' },
              { value: 'KG', label: 'Quilos' },
              { value: 'G', label: 'Gramas' },
            ]}
            value={unitMeasure}
            onChange={(value) => {
              setUnitMeasure(value);
              setBaseUnit(value === 'UN' ? 'UN' : 'G');
            }}
          />
          <Text className={`text-sm font-medium ${theme.textMuted}`}>Despensa</Text>
          <Segmented<PantryPolicy> options={[{ value: 'ALWAYS', label: 'Sempre' }, { value: 'ASK', label: 'Perguntar' }, { value: 'NEVER', label: 'Nunca' }]} value={policy} onChange={setPolicy} />
          <Text className="text-[11px] text-slate-400">Sempre: entra sem perguntar. Perguntar: pergunta toda vez. Nunca: pula sem perguntar.</Text>
          <TextField label="Alerta de estoque baixo (na unidade base)" value={threshold} onChangeText={setThreshold} keyboardType="numeric" placeholder="Ex.: 500" />
          <Button label={isNew ? 'Cadastrar produto' : 'Salvar alterações'} onPress={save} loading={saving} />
          <Text className="text-[11px] text-slate-400 text-center">A categoria vale p/ todas as notas futuras. A despensa lembra sua escolha.</Text>
          {!isNew ? (
            <Button label={`${ICONS.excluir} Excluir do catálogo`} variant="outline" onPress={() => setDeleteConfirm(true)} />
          ) : null}
        </Card>
      )}

      {/* v68: confirmação da exclusão — desvincula, não apaga dados */}
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
