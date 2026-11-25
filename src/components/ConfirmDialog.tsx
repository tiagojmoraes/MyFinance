/**
 * ConfirmDialog — caixa de diálogo de exclusão com botões coloridos (v7.0.6).
 *  - Vermelho = débito (despesa) · Verde = crédito (receita).
 *  - Exatamente os botões que o chamador passar (ex.: "Excluir apenas este" /
 *    "Excluir este e as próximas"); tocar fora (backdrop) fecha sem executar nada.
 */

import React from 'react';
import { Modal, View, Text, Pressable } from 'react-native';

export interface DialogButton {
  label: string;
  /** red = débito/despesa · green = crédito/receita · gray = ação neutra (Alterar/Duplicar) */
  color: 'red' | 'green' | 'gray';
  onPress: () => void | Promise<void>;
}

export function ConfirmDialog(props: {
  visible: boolean;
  title: string;
  message?: string;
  buttons: DialogButton[];
  onClose: () => void;
  /** Rodapé de ajuda; `null` esconde (padrão: aviso de fechar sem excluir). */
  hint?: string | null;
}) {
  return (
    <Modal transparent visible={props.visible} animationType="fade" onRequestClose={props.onClose}>
      {/* Backdrop: tocar fora fecha sem excluir */}
      <Pressable className="flex-1 bg-black/40 justify-end" onPress={props.onClose}>
        <Pressable
          className="bg-white rounded-2xl mx-3 mb-4 p-4"
          style={{ gap: 10 }}
          onPress={() => {}}
          accessibilityLabel={props.title}
        >
          <Text className="text-base font-bold text-slate-900">{props.title}</Text>
          {props.message ? (
            <Text className="text-xs text-slate-500 leading-4">{props.message}</Text>
          ) : null}
          {props.buttons.map((b) => (
            <Pressable
              key={b.label}
              onPress={b.onPress}
              className={`rounded-xl border px-3 py-3 ${
                b.color === 'red'
                  ? 'border-rose-100 bg-rose-50'
                  : b.color === 'gray'
                    ? 'border-slate-200 bg-slate-50'
                    : 'border-emerald-100 bg-emerald-50'
              }`}
              accessibilityRole="button"
              accessibilityLabel={b.label}
            >
              <Text
                className={`text-center text-[13px] font-bold leading-5 ${
                  b.color === 'red' ? 'text-rose-600' : b.color === 'gray' ? 'text-slate-700' : 'text-emerald-600'
                }`}
              >
                {b.label}
              </Text>
            </Pressable>
          ))}
          {props.hint === null ? null : (
            <Text className="text-xs text-slate-400 text-center">
              {props.hint ?? 'Toque fora da caixa para fechar sem excluir.'}
            </Text>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
