/** Tela CARTÕES DE CRÉDITO (v8→v70) — lista de cartões com botão "+".
 *  v70 (MELHORIA 2.4): a tela se chama "Cartões de Crédito" em todo o app
 *  (título, menu do Cadastro, seção da tela Início); o "＋" abre a TELA DE
 *  CADASTRAMENTO /cartao-novo (antes o formulário abria embaixo da lista —
 *  MELHORIA 2.3); campos "Dia do fechamento" e "Dia do vencimento" (sem
 *  "(1-31)") ficam na tela de cadastro e no detalhe do cartão.
 *  Cada cartão mostra limite e fatura aberta; tocar abre o detalhe (editar,
 *  limite, arquivar). Arquivados ficam numa seção separada e saem das escolhas.
 *  Regra de ciclo de vida: excluir só sem movimentações (no detalhe do cartão). */

import React from 'react';
import { View, Text,  Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, EmptyState, Badge } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { formatBRL } from '../src/lib/money';
import { ICONS } from '../src/theme/icons';

interface CardItem {
  id: string;
  name: string;
  last_four_digits: string | null;
  closing_day: number;
  due_day: number;
  limit_cents: number | null;
  archived: boolean;
  openInvoice: { id: string; dueCents: number; liveStatus: string } | null;
}

export default function CartoesScreen() {
  const services = useDataEffect();
  const [cards, setCards] = React.useState<CardItem[]>([]);

  useDataEffect(async (svc) => {
    const rows = await svc.db.getAllAsync<{
      id: string; name: string; last_four_digits: string | null; closing_day: number;
      due_day: number; limit_cents: number | null; archived_at: string | null;
    }>('SELECT id, name, last_four_digits, closing_day, due_day, limit_cents, archived_at FROM cards ORDER BY archived_at IS NOT NULL, name');
    const nextInvoices = await svc.invoices.getNextOpenInvoices(rows.map((card) => card.id));
    const items: CardItem[] = rows.map((card) => {
      const next = nextInvoices.get(card.id);
      return {
        id: card.id,
        name: card.name,
        last_four_digits: card.last_four_digits,
        closing_day: card.closing_day,
        due_day: card.due_day,
        limit_cents: card.limit_cents,
        archived: !!card.archived_at,
        openInvoice: next ? { id: next.invoice.id, dueCents: next.dueCents, liveStatus: next.liveStatus } : null,
      };
    });
    setCards(items);
  });

  const active = cards.filter((c) => !c.archived);
  const archived = cards.filter((c) => c.archived);

  const renderCard = (card: CardItem) => (
    <Pressable key={card.id} onPress={() => router.push(`/cartoes/${card.id}`)}>
      <Card className={`!py-3 mb-1 ${card.archived ? 'opacity-70' : ''}`}>
        <View className="flex-row justify-between items-center">
          <View className="flex-1">
            <View className="flex-row items-center gap-1.5">
              <Text className="font-semibold text-slate-900">
                {card.name}{card.last_four_digits ? ` ••${card.last_four_digits}` : ''}
              </Text>
              {card.archived ? (
                <Text className="text-[10px] font-semibold text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                  {ICONS.arquivar} ARQUIVADO
                </Text>
              ) : null}
            </View>
            <Text className="text-xs text-slate-500">
              Fecha dia {card.closing_day} · vence dia {card.due_day}
              {card.limit_cents != null ? ` · limite ${formatBRL(card.limit_cents)}` : ''}
            </Text>
          </View>
          {card.openInvoice ? (
            <View className="items-end gap-1">
              <Text className="font-bold text-slate-900">{formatBRL(card.openInvoice.dueCents)}</Text>
              <Badge status={card.openInvoice.liveStatus} />
            </View>
          ) : (
            // v67 (BUG 6): sem fatura em aberto = R$ 0,00 explícito (não some com o valor)
            <View className="items-end gap-1">
              <Text className="font-bold text-slate-400">{formatBRL(0)}</Text>
              <Text className="text-[10px] font-semibold text-slate-400">Sem fatura em aberto</Text>
            </View>
          )}
        </View>
      </Card>
    </Pressable>
  );

  return (
    <Screen
      title="Cartões de Crédito"
      action={
        // v70 (MELHORIA 2.3): o "＋" abre a TELA DE CADASTRAMENTO (padrão do app)
        <Pressable
          onPress={() => router.push('/cartao-novo')}
          accessibilityRole="button"
          accessibilityLabel="Adicionar novo cartão de crédito"
          className="bg-emerald-600 rounded-xl px-4 py-2"
        >
          <Text className="text-white font-bold text-lg leading-6">＋</Text>
        </Pressable>
      }
    >
      {active.length === 0 ? (
        <EmptyState icon={ICONS.cartoes} title="Nenhum cartão de crédito" hint="Toque no ＋ para cadastrar o primeiro." />
      ) : (
        active.map(renderCard)
      )}

      {archived.length > 0 ? (
        <>
          <View className="mt-2">
            <Text className="text-sm font-semibold uppercase tracking-wide text-slate-400">Arquivados</Text>
          </View>
          {archived.map(renderCard)}
        </>
      ) : null}

      <Text className="text-[11px] text-slate-400 text-center px-6">
        Toque em um cartão para ALTERAR (nome, dias, limite) e ARQUIVAR. Cartões com movimentação não podem ser excluídos. O "＋" abre a tela de cadastramento.
      </Text>
    </Screen>
  );
}
