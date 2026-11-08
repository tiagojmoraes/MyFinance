/**
 * NfceCameraArea (v38) — área de câmera À PROVA DE FALHAS para o QR Code da NFC-e.
 *
 * Por que existe: até a v37 a tela só tinha 2 estados (permissão OK → câmera;
 * senão → botão "Conceder permissão"). No Android, quando a permissão foi
 * negada EM DEFINITIVO (o usuário negou com "não perguntar de novo", o sistema
 * marcou negado ao reinstalar, ou o diálogo simplesmente não abre), o
 * requestPermission() resolve na hora SEM mostrar diálogo nenhum — o botão
 * parece morto, a câmera nunca abre e o usuário fica travado.
 *
 * Agora são 4 estados explícitos:
 *   1. Carregando (permission === null)
 *   2. Câmera ativa (granted) — com ErrorBoundary: se o módulo nativo quebrar,
 *      mostra orientação em vez de tela preta/crash
 *   3. Permissão ainda pode ser pedida → botão "Conceder permissão"
 *   4. Permissão NEGADA EM DEFINITIVO → botão "Abrir Ajustes do app"
 *      (Linking.openSettings leva direto à tela de permissões do app)
 * + uma linha de diagnóstico com o status exato, para reportar se persistir.
 */

import React from 'react';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Button, QrGlyph } from './ui';

/** Se o CameraView lançar erro nativo (permissão fora do manifest, módulo
 *  ausente no Expo Go antigo etc.), mostramos orientação em vez de crashar. */
class CameraErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function NfceCameraArea({ onScan, busy, tone = 'light', style }: {
  onScan: (data: string) => void;
  busy?: boolean;
  /** 'dark' = fundo escuro (modal tela-cheia); 'light' = tela clara */
  tone?: 'dark' | 'light';
  style?: object;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const dark = tone === 'dark';

  const hintText = dark ? 'text-slate-300' : 'text-slate-600';
  const hintSmall = dark ? 'text-slate-400' : 'text-slate-500';
  const diagText = dark ? 'text-slate-500' : 'text-slate-400';

  /** Estado 4: câmera quebrou no nativo mesmo com permissão concedida. */
  const cameraBrokenFallback = (
    <View className="flex-1 items-center justify-center gap-3 p-6">
      <QrGlyph size={56} color={dark ? '#94a3b8' : '#334155'} />
      <Text className={`${hintText} text-center font-semibold`}>
        A câmera não conseguiu abrir neste aparelho.
      </Text>
      <Text className={`${hintSmall} text-center text-xs`}>
        Feche e reabra o app. Se continuar, use a opção "colar o link da nota" logo abaixo — ela funciona sem câmera.
      </Text>
      <Button label="Tentar abrir a câmera de novo" variant="outline" onPress={() => requestPermission()} />
    </View>
  );

  // Estado 1: hook de permissão ainda carregando
  if (permission == null) {
    return (
      <View className="flex-1 items-center justify-center gap-3" style={style}>
        <ActivityIndicator color={dark ? '#e2e8f0' : '#0f766e'} />
        <Text className={hintSmall}>Preparando a câmera…</Text>
      </View>
    );
  }

  // Estado 2: permissão OK → câmera de verdade (com rede de segurança)
  if (permission.granted) {
    return (
      <View className="flex-1" style={style}>
        <CameraErrorBoundary fallback={cameraBrokenFallback}>
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={busy ? undefined : ({ data }) => onScan(data)}
          />
        </CameraErrorBoundary>
      </View>
    );
  }

  // Estado 4: negada em definitivo → os Ajustes do sistema são O caminho
  if (!permission.canAskAgain) {
    return (
      <View className="flex-1 items-center justify-center gap-3 p-6" style={style}>
        <QrGlyph size={56} color={dark ? '#94a3b8' : '#334155'} />
        <Text className={`${hintText} text-center font-bold`}>
          A permissão de câmera foi negada em definitivo — por isso a câmera não abre.
        </Text>
        <Text className={`${hintSmall} text-center text-xs`}>
          Toque abaixo e ative: Ajustes do Android → Apps → MyFinance → Permissões → Câmera → Permitir.
        </Text>
        <Button label="Abrir Ajustes do app" onPress={() => Linking.openSettings()} />
        <Text className={`${diagText} text-[10px]`}>
          Diagnóstico: permissão={permission.status} · pode pedir de novo=não
        </Text>
      </View>
    );
  }

  // Estado 3: ainda dá para pedir ao sistema
  return (
    <View className="flex-1 items-center justify-center gap-3 p-6" style={style}>
      <QrGlyph size={56} color={dark ? '#94a3b8' : '#334155'} />
      <Text className={`${hintText} text-center`}>
        Precisamos da permissão de câmera para escanear o QR Code da nota.
      </Text>
      <Button label="Conceder permissão" onPress={() => requestPermission()} />
      <Text className={`${hintSmall} text-center text-xs`}>
        Não abriu nada? A permissão pode ter ficada travada — use "Abrir Ajustes" ou cole o link da nota abaixo.
      </Text>
      <Pressable onPress={() => Linking.openSettings()}>
        <Text className="text-sky-600 font-semibold text-sm underline">Abrir Ajustes do app</Text>
      </Pressable>
      <Text className={`${diagText} text-[10px]`}>
        Diagnóstico: permissão={permission.status} · pode pedir de novo=sim
      </Text>
    </View>
  );
}
