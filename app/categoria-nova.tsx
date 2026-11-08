/**
 * Tela NOVA CATEGORIA (v70 — MELHORIA 2.3) — cadastro em TELA PRÓPRIA.
 *
 * Na tela Categorias o formulário de criar/editar abria EMBASSO da lista
 * (mesmo problema do "＋" das Contas). Agora a criação ("＋ Nova categoria")
 * e a edição (tocar na categoria) abrem ESTA tela.
 * Params: ?dir=DEBIT|CREDIT (pré-ajuste do filtro ao criar) · ?edit=ID (editar).
 */

import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen, Card, TextField, Select, Button, Segmented } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { showToast } from '../lib/toast';
import { ICONS, CATEGORY_ICON_OPTIONS, type CategoryDirection } from '../src/theme/icons';
import { kindTheme } from '../src/theme';

export default function CategoriaNovaScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const params = useLocalSearchParams<{ edit?: string; dir?: string }>();
  const editId = params.edit ? String(params.edit) : null;

  const [name, setName] = React.useState('');
  const [direction, setDirection] = React.useState<CategoryDirection>(
    params.dir === 'CREDIT' ? 'CREDIT' : 'DEBIT'
  );
  const [icon, setIcon] = React.useState<string>(CATEGORY_ICON_OPTIONS[0]);
  const [parentId, setParentId] = React.useState<string | null>(null);
  const [cats, setCats] = React.useState<Array<{ id: string; name: string; icon: string | null; direction: string; parent_id: string | null; archived_at: string | null }>>([]);
  const [saving, setSaving] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);

  useDataEffect(async (svc) => {
    const rows = await svc.categories.list();
    setCats(rows as unknown as Array<{ id: string; name: string; icon: string | null; direction: string; parent_id: string | null; archived_at: string | null }>);
    if (!loaded && editId) {
      const cat = rows.find((c: { id: string }) => c.id === editId) as { name: string; direction: string; icon: string | null; parent_id: string | null } | undefined;
      if (cat) {
        setName(cat.name);
        setDirection((cat.direction as CategoryDirection) ?? 'DEBIT');
        setIcon(cat.icon ?? CATEGORY_ICON_OPTIONS[0]);
        setParentId(cat.parent_id);
      } else {
        showToast('Categoria não encontrada', 'err');
        router.back();
      }
    }
    setLoaded(true);
  });

  const parents = cats.filter((c) => !c.parent_id && c.direction === direction && !c.archived_at);

  const save = async () => {
    if (!name.trim()) {
      showToast('Informe o nome da categoria', 'err');
      return;
    }
    setSaving(true);
    try {
      if (editId) {
        await services.categories.update(editId, { name, direction, icon, parentId });
        showToast('Categoria alterada');
      } else {
        await services.categories.create({ name, direction, icon, parentId });
        showToast('Categoria criada');
      }
      bump();
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen title={editId ? 'Alterar categoria' : 'Nova categoria'} subtitle={editId ? undefined : 'Débito (despesa) ou crédito (receita)'}>
      <Card className="gap-3">
        <TextField label="Nome" value={name} onChangeText={setName} placeholder="Ex.: Mercado" />
        <View className="gap-1">
          <Text className="text-sm font-medium text-slate-500">Direção (v8: débito vermelho, crédito verde)</Text>
          <Segmented<CategoryDirection>
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'DEBIT', label: `${ICONS.despesa} Débito` },
              { value: 'CREDIT', label: `${ICONS.receita} Crédito` },
            ]}
            activeBg={direction === 'DEBIT' ? kindTheme.EXPENSE.solid : kindTheme.INCOME.solid}
          />
        </View>
        <View className="gap-1">
          <Text className="text-sm font-medium text-slate-500">Pictograma (igual em todo o app)</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {CATEGORY_ICON_OPTIONS.map((opt) => (
              <Pressable
                key={opt}
                onPress={() => setIcon(opt)}
                className={`w-10 h-10 rounded-xl items-center justify-center border ${
                  icon === opt
                    ? direction === 'DEBIT' ? 'bg-rose-600 border-rose-600' : 'bg-emerald-600 border-emerald-600'
                    : 'bg-white border-slate-200'
                }`}
              >
                <Text className="text-lg">{opt}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
        <Select
          label="Categoria pai (opcional — vira subcategoria)"
          items={parents.map((p) => ({ id: p.id, label: `${p.icon ?? '🏷️'} ${p.name}` }))}
          selectedId={parentId}
          onSelect={setParentId}
          allowEmpty
          emptyLabel="— categoria principal —"
        />
        <View className="flex-row gap-2 mt-1">
          <View className="flex-1">
            <Button label="Cancelar" variant="outline" onPress={() => router.back()} />
          </View>
          <View className="flex-1">
            <Button label={editId ? 'Salvar' : 'Criar'} onPress={save} loading={saving} />
          </View>
        </View>
      </Card>
      <Text className="text-[11px] text-slate-400 text-center px-6">
        {ICONS.categorias} O mesmo pictograma de uma categoria aparece junto ao nome dela nas telas de lançamento e fluxo.
      </Text>
    </Screen>
  );
}
