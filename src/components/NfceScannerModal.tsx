/**
 * NfceScannerModal — scanner de QR Code da NFC-e em Modal tela-cheia.
 * Reutilizado pelo Lançamento (atalho QR ao lado do valor) e pela tela NFC-e.
 * Encapsula permissão de câmera e o estado "busy" durante a ingestão.
 *
 * v38: a câmera virou NfceCameraArea (4 estados: carregando / ativa / pedir
 * permissão / negada em definitivo → Ajustes do Android) e ganhou o
 * NfceManualInput — colar o link do QR ou a chave de 44 dígitos. Se a câmera
 * do aparelho falhar por QUALQUER motivo, o usuário ainda puxa os dados da
 * nota (mesmo caminho que funcionou nos testes do chat).
 *
 * v41: hint FINAL configurável (bottomHint) — no Novo Lançamento a nota NÃO
 * registra mais despesa sozinha: preenche o formulário para o usuário escolher
 * categoria, pagamento e estoque; a tela NFC-e mantém o registro automático.
 */

import React from 'react';
import { View, Text, Modal, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import { NfceCameraArea } from './NfceCameraArea';
import { NfceManualInput } from './NfceManualInput';

export function NfceScannerModal({ visible, onClose, onScan, busy, bottomHint }: {
  visible: boolean;
  onClose: () => void;
  onScan: (data: string) => void;
  busy?: boolean;
  /** v41: texto do rodapé — cada tela explica o QUE acontece depois da leitura. */
  bottomHint?: string;
}) {
  // Modal desmontado quando fechado: garante que a câmera não rode em background.
  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 bg-slate-950">
        <View className="px-4 pt-12 pb-4 flex-row items-center justify-between bg-black">
          <View className="flex-1">
            <Text className="text-white text-lg font-bold">Ler NFC-e</Text>
            <Text className="text-slate-400 text-xs mt-0.5">
              Aponte a câmera para o QR Code da nota fiscal
            </Text>
          </View>
          <Pressable onPress={onClose} className="px-3 py-2 rounded-lg bg-slate-800">
            <Text className="text-white font-semibold text-sm">Fechar</Text>
          </Pressable>
        </View>

        <View className="flex-1 m-4 rounded-2xl overflow-hidden bg-slate-900">
          <NfceCameraArea tone="dark" busy={busy} onScan={onScan} />
        </View>

        <ScrollView className="mx-4 mb-2" keyboardShouldPersistTaps="handled">
          <NfceManualInput tone="dark" busy={busy} onSubmit={onScan} />
        </ScrollView>

        <View className="items-center pb-6 gap-2">
          {busy ? (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator color="#ffffff" />
              <Text className="text-slate-300 text-sm">Puxando os dados da nota…</Text>
            </View>
          ) : (
            <Text className="text-slate-500 text-xs text-center px-8">
              {bottomHint ?? 'A leitura registra a despesa automaticamente com os dados da nota.'}
            </Text>
          )}
        </View>
      </View>
    </Modal>
  );
}
