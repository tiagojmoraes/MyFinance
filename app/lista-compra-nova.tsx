/**
 * NOVA LISTA DE COMPRA (v104) — tela PRÓPRIA para MONTAR listas salvas.
 * v107 — campo de quantidade na MESMA linha do produto (digita direto, sem
 * precisar tocar em ＋ antes). Linha com qtd válida entra na lista; apagar o
 * campo a retira. Texto não-numérico → borda vermelha, não conta. Botão "＋
 * Abaixo do mínimo" preenche o campo dos itens com estoque baixo sem apagar
 * o que o usuário já digitou. Ordem e foco do teclado preservados na rolagem.
 */

import React from 'react';
import { View, Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, TextField, Button, EmptyState, SectionTitle } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { showToast } from '../lib/toast';
import { formatStockQty, parseKgToGrams } from '../src/lib/money';

interface ClassifiedItem {
  product_id: string;
  name: string;
  base_unit: 'G' | 'ML' | 'UN' | null;
  quantity_base: number;
  low_threshold_base: number | null;
  isLow: boolean;
}

/** Calcula a quantidade em BASE (g / un / ml) a partir do texto digitado.
 *  Retorna 0 quando vazio ou inválido; > 0 quando válido. */
function parseBaseQty(item: ClassifiedItem, text: string): number {
  if (item.base_unit === 'G') {
    const g = parseKgToGrams(text);
    return Number.isFinite(g) && g > 0 ? g : 0;
  }
  const n = parseInt(text, 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** v107 — texto é válido quando o parser devolve > 0 (sem NaN, sem vazio).
 *  Tudo que não é parseável aqui cai em "inválido" (borda vermelha). */
function isValidQty(item: ClassifiedItem, text: string): boolean {
  if (!text || !text.trim()) return false;
  return parseBaseQty(item, text) > 0;
}

function placeholderFor(unit: 'G' | 'ML' | 'UN' | null): string {
  if (unit === 'G') return 'qtn (kg)';
  if (unit === 'ML') return 'qtn (ml)';
  return 'qtn (uni)';
}

export default function ListaCompraNovaScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [classified, setClassified] = React.useState<ClassifiedItem[]>([]);
  const [name, setName] = React.useState('');
  // v107 — texto cru por produto (sem pré-preenchimento). A linha entra na
  // lista automaticamente quando o parser devolve > 0.
  const [qtyText, setQtyText] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  useDataEffect(async (svc) => {
    const list = await svc.pantry.listClassifiedActive();
    setClassified(list as unknown as ClassifiedItem[]);
  });

  const setQty = (productId: string, text: string) => {
    setQtyText((cur) => ({ ...cur, [productId]: text }));
  };

  // v107 — qtd padrão do botão "Abaixo do mínimo": UN → 1, KG → 0,1 kg,
  // ML → 100. Mantido centralizado para reuso futuro.
  const defaultTextFor = (item: ClassifiedItem): string => {
    if (item.base_unit === 'G') return '0,1';
    if (item.base_unit === 'ML') return '100';
    return '1';
  };

  const addBelowMinimum = () => {
    const baixos = classified.filter((i) => i.isLow);
    if (baixos.length === 0) {
      showToast('Nada abaixo do mínimo — tudo em dia');
      return;
    }
    setQtyText((cur) => {
      // v107 — só preenche quem ainda não tem nada digitado. Usuário
      // digitou → não sobrescreve; mantém a escolha dele.
      const next = { ...cur };
      let added = 0;
      for (const b of baixos) {
        if (next[b.product_id] && next[b.product_id].trim()) continue;
        next[b.product_id] = defaultTextFor(b);
        added += 1;
      }
      if (added === 0) {
        showToast('Todos já tinham quantidade informada');
      } else {
        showToast(`${added} produto(s) abaixo do mínimo entraram na lista`);
      }
      return next;
    });
  };

  const validCount = React.useMemo(
    () => classified.reduce((acc, item) => acc + (isValidQty(item, qtyText[item.product_id]) ? 1 : 0), 0),
    [classified, qtyText],
  );

  const save = async () => {
    const rows = classified
      .map((item) => {
        const text = qtyText[item.product_id] ?? '';
        const qtyBase = parseBaseQty(item, text);
        return qtyBase > 0 ? { productId: item.product_id, qtyBase } : null;
      })
      .filter((r): r is { productId: string; qtyBase: number } => r !== null);
    if (rows.length === 0) {
      showToast('Selecione ao menos um produto', 'err');
      return;
    }
    const listName = name.trim() || 'Lista de Compra';
    setSaving(true);
    try {
      await services.shoppingList.create(listName, rows);
      bump();
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen title="Nova Lista de Compra">
      <Card className="gap-2">
        <TextField
          label="Nome da lista"
          value={name}
          onChangeText={setName}
          placeholder="Ex.: Feira da semana"
        />
        <View className="flex-row gap-2 mt-1">
          <View className="flex-1">
            <Button label="Cancelar" variant="outline" onPress={() => router.back()} />
          </View>
          <View className="flex-1">
            <Button label={`Criar Lista (${validCount})`} onPress={save} loading={saving} />
          </View>
        </View>
      </Card>

      <Button label={`＋ Abaixo do mínimo (${classified.filter((i) => i.isLow).length})`} variant="outline" onPress={addBelowMinimum} />

      <SectionTitle>Produtos classificados ({classified.length})</SectionTitle>
      {classified.length === 0 ? (
        <EmptyState icon="🧺" title="Sem produtos classificados" hint="Classifique itens pelas notas ou cadastre no catálogo para montar a lista." />
      ) : (
        classified.map((item) => {
          const text = qtyText[item.product_id] ?? '';
          const trimmed = text.trim();
          // v107 — só pinta de verde quando digitou ALGO válido. Vazio fica
          // neutro; texto lixo fica com borda vermelha.
          const na = trimmed !== '' && isValidQty(item, text);
          const invalid = trimmed !== '' && !isValidQty(item, text);
          const kb = item.base_unit === 'G' ? 'decimal-pad' as const : 'numeric' as const;
          const nameColor = na ? 'text-emerald-800' : 'text-slate-700';
          const borderClass = invalid
            ? 'border-red-400'
            : na
              ? 'border-emerald-300'
              : 'border-slate-200';
          const bgClass = na ? 'bg-emerald-50' : 'bg-white';
          return (
            <View
              key={item.product_id}
              className={`flex-row items-center gap-2 rounded-lg px-3 py-2 border ${bgClass} ${borderClass}`}
            >
              <View className="flex-1 min-w-0">
                <Text className={`text-sm font-medium ${nameColor}`} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text className="text-xs text-slate-400">
                  {formatStockQty(item.base_unit, item.quantity_base)}{item.isLow ? ' · ⚠ estoque baixo' : ''}
                </Text>
              </View>
              <TextInput
                value={text}
                onChangeText={(t) => setQty(item.product_id, t)}
                keyboardType={kb}
                returnKeyType="next"
                placeholder={placeholderFor(item.base_unit)}
                placeholderTextColor="#94a3b8"
                // v107 — campo compacto, sem label, à direita do cartão.
                // textAlign=right mantém o texto pressionado contra a borda
                // e casa com o preço (futuro).
                textAlign="right"
                style={{ minWidth: 96, paddingVertical: 4, fontSize: 14, color: '#0f172a' }}
              />
            </View>
          );
        })
      )}
    </Screen>
  );
}
