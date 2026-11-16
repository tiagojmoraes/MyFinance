/** Tela/modal "Registrar Pagamento" (v10 — Req 7; v16):
 *  Aberta pelo botão "Registrar Pagamento" da fatura. Segue RIGOROSAMENTE os
 *  padrões visuais e as cores do aplicativo (mesmos Screen/Card/Button).
 *  Contém APENAS:
 *   1. "Conta de pagamento" — obrigatória (mesma regra de contas do app:
 *      não arquivadas, ordenadas por nome);
 *   2. "Valor" — já vem PREENCHIDO com o saldo devido.
 *  v16 (melhoria 3): a mensagem de instrução da máscara de digitação
 *  ("digitação da direita para a esquerda...") foi REMOVIDA.
 *  v16 (bug 4): pagamento adicional é ACEITO — o excedente segue a regra
 *  padrão de cartão pela data de corte e vai para a fatura em aberto; se isso
 *  acontecer, o usuário é avisado na confirmação.
 *  Ao confirmar: salva, fecha e VOLTA para a tela da fatura. SEM alertas de
 *  sucesso quando o pagamento fica na própria fatura (v10).
 */

import React from 'react';
import { Text, Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen, Card, Button, Select, KeyValue, Badge } from '../../../../../src/components/ui';
import { MoneyInput } from '../../../../../src/components/MoneyInput';
import { useDataEffect } from '../../../../../src/components/useDataEffect';
import { useAppStore } from '../../../../../src/store/appStore';
import { formatBRL } from '../../../../../src/lib/money';
import { monthLabel } from '../../../../../src/lib/dates';
import { showToast } from '../../../../../lib/toast';

export default function RegistrarPagamentoScreen() {
  const { id, mes } = useLocalSearchParams<{ id: string; mes: string }>();
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [invoiceId, setInvoiceId] = React.useState<string | null>(null);
  const [dueCents, setDueCents] = React.useState(0);
  const [payCents, setPayCents] = React.useState(0);
  const [accountId, setAccountId] = React.useState<string | null>(null);
  const [accounts, setAccounts] = React.useState<Array<{ id: string; label: string }>>([]);
  const [liveStatus, setLiveStatus] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);

  useDataEffect(async (svc) => {
    const d = await svc.invoices.getInvoiceDetailByCardMonth(id, mes);
    const accs = await svc.db.getAllAsync<{ id: string; name: string }>(
      'SELECT id, name FROM accounts WHERE archived_at IS NULL ORDER BY name'
    );
    setAccounts(accs.map((a) => ({ id: a.id, label: a.name })));
    if (d) {
      setInvoiceId(d.invoice.id);
      setDueCents(d.dueCents);
      // v10 (Req 7): valor já vem preenchido com o SALDO DEVIDO da fatura
      setPayCents(d.dueCents);
      setLiveStatus(d.liveStatus);
    }
    setLoaded(true);
  }, [id, mes]);

  const confirmar = async () => {
    try {
      if (!invoiceId) throw new Error('Fatura não encontrada');
      if (!accountId) throw new Error('Selecione a conta de pagamento');
      if (payCents <= 0) throw new Error('Informe um valor maior que zero');
      setSaving(true);
      const r = await services.invoices.payInvoice({
        invoiceId,
        fromAccountId: accountId,
        amountCents: payCents,
      });
      bump();
      // v16 (bug 4): quando o EXCEDENTE foi roteado pela regra de corte para a
      // fatura em aberto, o usuário é avisado (o valor saiu da fatura vista).
      if (r.routedMonth) {
        // v19: regra de corte avisada sem popup — aviso discreto
        showToast(
          `Regra de corte: excedente (${formatBRL(r.surplusCents)}) aplicado à fatura ${monthLabel(r.routedMonth)}`
        );
      }
      // v10: sem alerta de sucesso — fecha o modal e volta para a FATURA (que
      // mostra o pictograma de confirmação com data e valor)
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      title="Registrar Pagamento"
      subtitle={`Fatura ${monthLabel(mes)}`}
      action={liveStatus ? <Badge status={liveStatus} /> : undefined}
    >
      {!loaded ? (
        <Card><Text className="text-slate-500">Carregando...</Text></Card>
      ) : (
        <>
          <Card>
            <KeyValue k="Saldo devido da fatura" v={formatBRL(dueCents)} bold />
          </Card>

          <Card className="gap-3">
            <Select
              label="Conta de pagamento"
              items={accounts}
              selectedId={accountId}
              onSelect={setAccountId}
            />
            <Text className="text-[11px] text-slate-500 -mt-1">
              Obrigatória — o pagamento debita esta conta na data de hoje.
            </Text>

            <MoneyInput
              label="Valor do pagamento"
              cents={payCents}
              onChangeCents={setPayCents}
            />

            <Button label="Registrar Pagamento" onPress={confirmar} loading={saving} disabled={saving} />
          </Card>
        </>
      )}
    </Screen>
  );
}
