import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { BANK_INSTITUTIONS, bankByCode } from '../lib/banks';

export function BankCarousel({ value, onChange }: {
  value: string | null;
  onChange: (code: string) => void;
}) {
  const banks = React.useMemo(() => {
    const selected = value ? bankByCode(value) : null;
    return selected && !BANK_INSTITUTIONS.some((bank) => bank.code === selected.code)
      ? [selected, ...BANK_INSTITUTIONS]
      : BANK_INSTITUTIONS;
  }, [value]);

  return (
    <View className="gap-1">
      <Text className="text-sm font-medium text-slate-500">Instituição financeira</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {banks.map((bank) => {
          const selected = value === bank.code;
          return (
            <Pressable
              key={bank.code}
              onPress={() => onChange(bank.code)}
              accessibilityRole="button"
              accessibilityLabel={bank.name}
              accessibilityState={{ selected }}
              className={`w-28 items-center gap-2 rounded-xl border p-3 ${selected ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 bg-white'}`}
            >
              <View
                className="h-11 w-11 items-center justify-center rounded-full"
                style={{ backgroundColor: bank.color }}
              >
                <Text
                  className="font-bold"
                  style={{ color: bank.textColor ?? '#ffffff' }}
                >
                  {bank.short}
                </Text>
              </View>
              <Text className={`text-center text-xs font-semibold ${selected ? 'text-emerald-800' : 'text-slate-700'}`}>
                {bank.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
