/**
 * NfceManualInput (v38→v40) — plano B que SEMPRE funciona, sem câmera.
 *
 * Na v21 o campo de digitar/colar foi removido ("o fluxo é só a câmera").
 * Resultado: quando a câmera falha no aparelho, o usuário fica sem NENHUM
 * caminho. A v38 devolveu o campo. A v40 MATA A DIGITAÇÃO:
 *  · botão "📋 Colar e consultar" — lê o CLIPBOARD (expo-clipboard) e já
 *    dispara a consulta num toque só;
 *  · HISTÓRICO das 3 últimas entradas (persistido no banco) — um toque
 *    reconsulta a mesma nota, sem digitar/colar nada de novo.
 *
 * Receita garantida para o usuário (sem câmera do app):
 *   1. Abra a câmera do PRÓPRIO celular (a do sistema, que sempre escaneia).
 *   2. Aponte para o QR Code da nota → o navegador abre a página da SEFAZ.
 *   3. Copie o link da barra de endereço → toque "Colar e consultar" aqui.
 */

import React from 'react';
import { Text, TextInput, View, Pressable } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Button } from './ui';
import { showToast } from '../../lib/toast';

/** Rótulo curto do histórico: "chave …831362" ou "link …qrcode?p=…". */
function recentLabel(value: string): string {
  const m = value.match(/\d{44}/);
  if (m) return `chave …${m[0].slice(-10)}`;
  const one = value.replace(/\s+/g, ' ').trim();
  return one.length > 38 ? `…${one.slice(-37)}` : one;
}

export function NfceManualInput({ onSubmit, busy, tone = 'light', recentInputs, onUseRecent }: {
  onSubmit: (input: string) => void;
  busy?: boolean;
  /** 'dark' = fundo escuro (modal tela-cheia); 'light' = tela clara */
  tone?: 'dark' | 'light';
  /** v40: últimas entradas usadas (um toque reconsulta). */
  recentInputs?: string[];
  /** v40: o usuário tocou numa entrada do histórico. */
  onUseRecent?: (value: string) => void;
}) {
  const [text, setText] = React.useState('');
  const dark = tone === 'dark';

  const title = dark ? 'text-slate-200' : 'text-slate-800';
  const inputCls = dark
    ? 'text-slate-100 border-slate-700 bg-slate-900'
    : 'text-slate-900 border-slate-300 bg-white';
  const hint = dark ? 'text-slate-400' : 'text-slate-500';
  const chipCls = dark
    ? 'bg-slate-800 text-slate-200 border-slate-700'
    : 'bg-slate-100 text-slate-700 border-slate-200';

  /** v40: lê o clipboard e JÁ consulta — colar virou um toque. */
  const pasteAndGo = async () => {
    if (busy) return;
    try {
      const clip = await Clipboard.getStringAsync();
      const value = (clip ?? '').trim();
      if (!value) {
        showToast('Clipboard vazio — copie o link da nota ou a chave de 44 dígitos primeiro', 'err');
        return;
      }
      setText(value);
      onSubmit(value);
    } catch {
      showToast('Não consegui ler o clipboard — use o toque longo no campo para colar', 'err');
    }
  };

  const submit = () => {
    const value = text.trim();
    if (!value || busy) return;
    setText('');
    onSubmit(value);
  };

  return (
    <View className="gap-2">
      <Text className={`${title} text-sm font-bold`}>Sem câmera? Cole o link da nota 👇</Text>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Link do QR (https://www.nfce.fazenda.sp.gov.br/…) ou chave de 44 dígitos"
        placeholderTextColor={dark ? '#64748b' : '#94a3b8'}
        className={`${inputCls} border rounded-xl px-3 py-2.5 text-sm`}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        numberOfLines={2}
        editable={!busy}
      />
      <View className="flex-row gap-2">
        <View className="flex-1">
          {/* v68: no modal ESCURO o botão "Colar e consultar" era preto no preto
              (invisível) — virou BRANCO (contorno e texto), pedido do usuário */}
          <Button
            label="📋 Colar e consultar"
            variant="outline"
            onPress={pasteAndGo}
            loading={busy}
            outlineClass={dark ? 'bg-transparent border border-white' : undefined}
            outlineTextClass={dark ? 'text-white' : undefined}
          />
        </View>
        <View className="flex-1">
          <Button
            label={busy ? 'Consultando…' : 'Puxar dados da nota'}
            onPress={submit}
            loading={busy}
            disabled={busy || text.trim() === ''}
          />
        </View>
      </View>
      {/* v40 — HISTÓRICO: as últimas notas consultadas, um toque para repetir */}
      {recentInputs && recentInputs.length > 0 && onUseRecent ? (
        <View className="gap-1">
          <Text className={`${hint} text-[11px] font-semibold`}>Últimas consultas (toque para repetir):</Text>
          <View className="flex-row flex-wrap gap-1.5">
            {recentInputs.map((r, i) => (
              <Pressable
                key={`${i}-${r.slice(-12)}`}
                onPress={() => !busy && onUseRecent(r)}
                disabled={busy}
                className={`border rounded-full px-2.5 py-1 ${chipCls}`}
                accessibilityRole="button"
                accessibilityLabel={`Reconsultar ${recentLabel(r)}`}
              >
                <Text className={`text-[11px] font-semibold ${dark ? 'text-slate-200' : 'text-slate-700'}`} numberOfLines={1}>
                  🕘 {recentLabel(r)}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      <Text className={`${hint} text-[11px] leading-4`}>
        Garantia sem câmera: escaneie o QR com a câmera do próprio celular, copie o link que abrir no navegador e toque em "Colar e consultar" — ou digite a chave de 44 dígitos que está na nota.
      </Text>
    </View>
  );
}
