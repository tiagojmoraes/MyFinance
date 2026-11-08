/** Revisão de conciliação — linhas ambíguas, novos lançamentos e matches automáticos.
 *  v42 — SUGESTÃO DE NFC-e (pedido do usuário): nas seções Ambíguas e Novos
 *  lançamentos, linhas que batem com uma NFC-e JÁ LANÇADA (mesmo valor,
 *  data ±5 dias) mostram o selo "parece NFC-e …" e a vinculação em 1 TOQUE —
 *  evita duplicidade quando o casamento automático falha. Se a nota estava em
 *  outra conta, o lançamento move para a conta do extrato (foi lá que saiu).
 */

import React from 'react';
import { View, Text,  } from 'react-native';
import { showToast } from '../../lib/toast';
import { useLocalSearchParams } from 'expo-router';
import { Screen, Card, Badge, SectionTitle, EmptyState, Button } from '../../src/components/ui';
import { useDataEffect } from '../../src/components/useDataEffect';
import { useAppStore } from '../../src/store/appStore';
import { formatBRL } from '../../src/lib/money';
import { ymdToBr } from '../../src/lib/dates';

interface LineRow {
  id: string;
  fitid: string;
  posted_on: string | null;
  amount_cents: number | null;
  memo: string | null;
  matched_transaction_id: string | null;
  match_status: string;
}

export default function OfxReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [lines, setLines] = React.useState<LineRow[]>([]);

  const load = React.useCallback(async () => {
    const detail = await services.ofx.getImportDetail(id);
    if (!detail) return;
    setLines(detail.lines as unknown as LineRow[]);
  }, [services, id]);

  useDataEffect(load, [id]);

  const group = (status: string) => lines.filter((l) => l.match_status === status);

  const createForLine = async (line: LineRow) => {
    try {
      await services.ofx.createTransactionForLine(line.id);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  const linkNfce = async (line: LineRow, txId: string) => {
    try {
      const res = await services.ofx.linkNfceSuggestion(line.id, txId);
      showToast(
        res.movedAccount
          ? 'Vinculado à NFC-e — o lançamento foi movido para a conta do extrato'
          : 'Vinculado à NFC-e — sem lançamento duplicado'
      );
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  const renderMatched = (line: LineRow) => (
    <Card key={line.id} className="!py-3">
      <View className="flex-row justify-between items-center gap-2">
        <View className="flex-1">
          <Text className="font-semibold text-slate-900" numberOfLines={2}>{line.memo ?? '(sem memo)'}</Text>
          <Text className="text-xs text-slate-500">
            {line.posted_on ? ymdToBr(line.posted_on) : '—'} · FITID {line.fitid}
          </Text>
        </View>
        <Text className={`font-bold ${line.amount_cents != null ? (line.amount_cents > 0 ? 'text-emerald-600' : 'text-rose-600') : 'text-slate-900'}`}>
          {line.amount_cents != null ? formatBRL(line.amount_cents) : '—'}
        </Text>
      </View>
    </Card>
  );

  return (
    <Screen title="Conciliação" subtitle="Revisão de linhas do extrato">
      <SectionTitle>Ambíguas ({group('AMBIGUOUS').length})</SectionTitle>
      {group('AMBIGUOUS').length === 0 ? (
        <Card><Text className="text-slate-500 text-sm">Nada a revisar.</Text></Card>
      ) : (
        group('AMBIGUOUS').map((line) => <AmbiguousCard key={line.id} line={line} services={services} reload={async () => { bump(); await load(); }} />)
      )}

      <SectionTitle>Novos lançamentos ({group('NEW_TX').length})</SectionTitle>
      {group('NEW_TX').length === 0 ? (
        <Card><Text className="text-slate-500 text-sm">Nenhum.</Text></Card>
      ) : (
        group('NEW_TX').map((line) => (
          <Card key={line.id} className="!py-3">
            <View className="flex-row justify-between items-center gap-2">
              <View className="flex-1">
                <Text className="font-semibold text-slate-900" numberOfLines={2}>{line.memo ?? '(sem memo)'}</Text>
                <Text className="text-xs text-slate-500">{line.posted_on ? ymdToBr(line.posted_on) : '—'}</Text>
              </View>
              <Text className={`font-bold ${line.amount_cents != null ? (line.amount_cents > 0 ? 'text-emerald-600' : 'text-rose-600') : 'text-slate-900'}`}>
                {line.amount_cents != null ? formatBRL(line.amount_cents) : '—'}
              </Text>
            </View>
            {/* v42: selo de sugestão — esta linha parece uma NFC-e já lançada */}
            <NfceSuggestionBox line={line} onLink={(txId) => linkNfce(line, txId)} />
            <View className="mt-2">
              <Button label="Criar transação agora" variant="outline" onPress={() => createForLine(line)} />
            </View>
          </Card>
        ))
      )}

      <SectionTitle>Conciliadas automaticamente ({group('MATCHED_AUTO').length})</SectionTitle>
      {group('MATCHED_AUTO').length === 0 ? (
        <Card><Text className="text-slate-500 text-sm">Nenhum match nesta importação.</Text></Card>
      ) : (
        group('MATCHED_AUTO').map((line) => renderMatched(line))
      )}
    </Screen>
  );
}

function AmbiguousCard({ line, services, reload }: {
  line: LineRow;
  services: ReturnType<typeof import('../../src/services').buildServices>;
  reload: () => Promise<void>;
}) {
  const [candidates, setCandidates] = React.useState<Array<{ id: string; description: string; occurred_on: string; amount_cents: number }>>([]);

  React.useEffect(() => {
    services.ofx.getLineCandidates(line.id).then((rows) => setCandidates(rows as never));
  }, [services, line.id]);

  const linkNfce = async (txId: string) => {
    try {
      const res = await services.ofx.linkNfceSuggestion(line.id, txId);
      showToast(
        res.movedAccount
          ? 'Vinculado à NFC-e — o lançamento foi movido para a conta do extrato'
          : 'Vinculado à NFC-e — sem lançamento duplicado'
      );
      await reload();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  return (
    <Card className="!py-3 mb-1">
      <View className="flex-row justify-between items-center gap-2">
        <View className="flex-1">
          <Text className="font-semibold text-slate-900" numberOfLines={2}>{line.memo ?? '(sem memo)'}</Text>
          <Text className="text-xs text-slate-500">{line.posted_on ? ymdToBr(line.posted_on) : '—'}</Text>
        </View>
        <Text className={`font-bold ${line.amount_cents != null ? (line.amount_cents > 0 ? 'text-emerald-600' : 'text-rose-600') : 'text-slate-900'}`}>{line.amount_cents != null ? formatBRL(line.amount_cents) : '—'}</Text>
      </View>
      <Text className="text-xs font-semibold text-amber-700 mt-2">Candidatos (mesmo valor na janela de datas):</Text>
      {/* v42: selo de sugestão — esta linha parece uma NFC-e já lançada */}
      <NfceSuggestionBox line={line} onLink={linkNfce} />
      {candidates.length === 0 ? (
        <Text className="text-xs text-slate-500 mt-1">Nenhum candidato — crie um novo lançamento.</Text>
      ) : (
        candidates.map((c) => (
          <View key={c.id} className="flex-row justify-between items-center py-1.5 border-b border-slate-100 last:border-0">
            <View className="flex-1">
              <Text className="text-sm text-slate-800" numberOfLines={1}>{c.description}</Text>
              <Text className="text-[11px] text-slate-500">{ymdToBr(c.occurred_on)} · {formatBRL(c.amount_cents)}</Text>
            </View>
            <Text
              className="text-xs font-bold text-emerald-700 bg-emerald-50 rounded-lg px-2.5 py-1.5"
              onPress={async () => {
                await services.ofx.linkLine(line.id, c.id);
                await reload();
              }}
            >
              Vincular
            </Text>
          </View>
        ))
      )}
      <View className="mt-2">
        <Button
          label="Criar novo lançamento desta linha"
          variant="outline"
          onPress={async () => {
            try {
              await services.ofx.createTransactionForLine(line.id);
              await reload();
            } catch (err) {
              showToast(err instanceof Error ? err.message : String(err), 'err');
            }
          }}
        />
      </View>
    </Card>
  );
}

/**
 * v42 — SELO DE SUGESTÃO DE NFC-e: procura uma NFC-e já lançada com o mesmo
 * valor (data ±5 dias, qualquer conta). Achou? Mostra "🧾 parece NFC-e …"
 * com o botão de vinculação em 1 toque. Nada duplica: a linha OFX passa a
 * apontar para o lançamento que já existia.
 */
function NfceSuggestionBox({ line, onLink }: {
  line: LineRow;
  onLink: (transactionId: string) => void | Promise<void>;
}) {
  const services = useDataEffect();
  const [sugg, setSugg] = React.useState<Array<{
    id: string;
    description: string;
    occurred_on: string;
    amount_cents: number;
    account_name: string | null;
    store_name: string | null;
  }> | null>(null);

  React.useEffect(() => {
    let alive = true;
    services.ofx
      .findNfceSuggestions(line.id)
      .then((rows) => {
        if (alive) setSugg(rows);
      })
      .catch(() => {
        if (alive) setSugg([]);
      });
    return () => {
      alive = false;
    };
  }, [services, line.id]);

  if (!sugg || sugg.length === 0) return null;
  return (
    <View className="mt-2 bg-sky-50 rounded-lg p-2 gap-1">
      <Text className="text-xs font-semibold text-sky-800">🧾 Parece uma NFC-e já lançada</Text>
      {sugg.map((s) => (
        <View key={s.id} className="flex-row justify-between items-center gap-2">
          <View className="flex-1">
            <Text className="text-sm text-slate-800" numberOfLines={1}>
              {s.store_name ?? s.description} · {ymdToBr(s.occurred_on)} · {formatBRL(s.amount_cents)}
            </Text>
            {s.account_name ? (
              <Text className="text-[11px] text-slate-500" numberOfLines={1}>
                lançada em: {s.account_name} — ao vincular, o lançamento vai para a conta do extrato
              </Text>
            ) : null}
          </View>
          <Text
            className="text-xs font-bold text-emerald-700 bg-emerald-50 rounded-lg px-2.5 py-1.5"
            onPress={() => onLink(s.id)}
          >
            Vincular à NFC-e
          </Text>
        </View>
      ))}
    </View>
  );
}
