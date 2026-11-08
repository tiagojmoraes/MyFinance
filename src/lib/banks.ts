/** v54 — Catálogo de bancos (FEBRABAN) + bandeiras de cartão.
 *  Logo = círculo com cor da marca + iniciais (sem usar marca registrada como imagem).
 *  Isso basta para o usuário reconhecer o banco na hora de cadastrar a conta/cartão
 *  e para o OFX saber qual banco é (BANKID -> bank_code).
 */
export interface BankInfo {
  code: string; // FEBRABAN: "341", "260", "000"=Outro, "CASH"=Dinheiro
  name: string;
  short: string; // iniciais no círculo
  color: string; // cor da marca
  textColor?: string;
  type: 'BANK' | 'DIGITAL' | 'OTHER';
}
export const BANK_CATALOG: BankInfo[] = [
  { code: '260', name: 'Nubank', short: 'Nu', color: '#820AD1', type: 'DIGITAL' },
  { code: '341', name: 'Itaú', short: 'Itaú', color: '#EC7000', type: 'BANK' },
  { code: '237', name: 'Bradesco', short: 'Bra', color: '#CC092F', type: 'BANK' },
  { code: '033', name: 'Santander', short: 'San', color: '#EC0000', type: 'BANK' },
  { code: '001', name: 'Banco do Brasil', short: 'BB', color: '#FFEF00', textColor: '#003399', type: 'BANK' },
  { code: '104', name: 'Caixa', short: 'CX', color: '#005CA9', type: 'BANK' },
  { code: '077', name: 'Inter', short: 'In', color: '#FF7A00', type: 'DIGITAL' },
  { code: '336', name: 'C6 Bank', short: 'C6', color: '#111111', type: 'DIGITAL' },
  { code: '323', name: 'Mercado Pago', short: 'MP', color: '#009EE3', type: 'DIGITAL' },
  { code: '536', name: 'Neon', short: 'Ne', color: '#00A3A3', type: 'DIGITAL' },
  { code: '380', name: 'PicPay', short: 'PP', color: '#11C76F', type: 'DIGITAL' },
  { code: '102', name: 'XP', short: 'XP', color: '#000000', type: 'DIGITAL' },
  { code: '208', name: 'BTG Pactual', short: 'BTG', color: '#001E41', type: 'BANK' },
  { code: '748', name: 'Sicredi', short: 'Si', color: '#00A651', type: 'BANK' },
  { code: '756', name: 'Sicoob', short: 'Si', color: '#003B71', type: 'BANK' },
  { code: '212', name: 'Original', short: 'Or', color: '#00A868', type: 'DIGITAL' },
  { code: '290', name: 'PagBank', short: 'Pag', color: '#FFC800', textColor: '#111111', type: 'DIGITAL' },
  { code: '077', name: 'Banco Inter (alt)', short: 'In', color: '#FF7A00', type: 'DIGITAL' },
  { code: '000', name: 'Outro banco', short: '••', color: '#64748B', type: 'OTHER' },
  { code: 'CASH', name: 'Dinheiro', short: 'R$', color: '#059669', type: 'OTHER' },
];
// Dedup por código (Inter duplicado acima é só fallback)
export const BANKS_BY_CODE = new Map<string, BankInfo>();
for (const b of BANK_CATALOG) if (!BANKS_BY_CODE.has(b.code)) BANKS_BY_CODE.set(b.code, b);
export function bankByCode(code: string | null | undefined): BankInfo | null {
  if (!code) return null;
  return BANKS_BY_CODE.get(code) ?? null;
}
export function bankByName(name: string): BankInfo | null {
  const n = name.trim().toLowerCase();
  return BANK_CATALOG.find(b => b.name.toLowerCase() === n) ?? null;
}
export const CARD_BRANDS = [
  { id: 'VISA', label: 'Visa', color: '#1A1F71', short: 'VISA' },
  { id: 'MASTERCARD', label: 'Mastercard', color: '#EB001B', short: 'MC' },
  { id: 'ELO', label: 'Elo', color: '#FFCB05', short: 'ELO' },
  { id: 'AMEX', label: 'Amex', color: '#2E77BC', short: 'AX' },
  { id: 'HIPERCARD', label: 'Hipercard', color: '#B50025', short: 'HC' },
  { id: 'OUTRA', label: 'Outra', color: '#64748B', short: '••' },
] as const;
export function cardBrandById(id: string | null | undefined) {
  return CARD_BRANDS.find(b => b.id === id) ?? CARD_BRANDS[5];
}
