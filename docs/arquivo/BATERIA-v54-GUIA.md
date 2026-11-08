# v54 — Bancos com logo + Cartão amarrado ao OFX — GUIA DE IMPLEMENTAÇÃO
## 1. Conta: cadastro com logo do banco
- Novo arquivo `src/lib/banks.ts`: BANK_CATALOG (FEBRABAN: 001 BB, 033 Santander, 104 Caixa, 237 Bradesco, 341 Itaú, 260 Nubank, 077 Inter, 336 C6, 323 Mercado Pago, etc.) + CARD_BRANDS (Visa, Master, Elo, Amex, Hipercard).
- Logo = círculo com cor da marca + iniciais (ex: Nubank roxo 'Nu', Itaú laranja 'Itaú'). Sem usar imagem de marca registrada.
- Migração: `ALTER TABLE accounts ADD COLUMN bank_code TEXT, bank_acct_last4 TEXT`
- Tela `app/contas.tsx`: grade de bancos (círculo + nome) antes do nome da conta. Ao tocar num banco, preenche `bank_code` e sugere nome ("Itaú Corrente"). Campo "Últimos 4 da conta" (opcional, 4 dígitos) -> `bank_acct_last4`.
- Lista de contas: mostra círculo do banco + nome. Na Home, idem.

## 2. Cartão: amarrado ao OFX
- Migração: `ALTER TABLE cards ADD COLUMN bank_code TEXT, card_brand TEXT` (ex: Nubank + Mastercard)
- Tela `app/cartoes.tsx`: ao criar cartão, escolhe BANCO (mesma grade) + BANDEIRA (Visa/Master/Elo/Amex/Hipercard) + últimos 4. Mostra círculo do banco + bandeira no card.
- Tela do cartão `app/cartoes/[id].tsx`: botão "Importar OFX deste cartão" -> vai para `/ofx?cardId=...`
- Tela `app/ofx.tsx`: novo modo `?cardId=`:
  - Se `cardId` vier, o título vira "Importar OFX do cartão ••3456", o Select de conta some.
  - Detecta `ofxKind(content)`: se for BANK e o usuário está no modo cartão -> avisa "Este OFX é de CONTA, não de cartão. Importar na conta certa?" e não importa errado.
  - Se for CARD, casa por `ofxCardLast4` == `cards.last_four_digits`. Se não casar, mostra "Últimos 4 não batem (OFX ...3456, cartão ...9999). Continuar mesmo assim?"
  - Importação de cartão: cria ITENS DE FATURA (não moves em conta). Saldo da conta não muda. Fatura do mês do vencimento recebe o item.

## 3. OFX: detecção automática (já implementada no parser)
- `src/parsers/ofx.ts`: `ofxKind()` = CARD se tem <CCSTMTTRN> / <CCACCTFROM>, BANK se tem <STMTTRN> / <BANKMSGSRSV1>. `ofxCardLast4()` = últimos 4 do ACCTID do cartão.
- Na tela OFX sem cardId: após ler o arquivo, se `parsed.bankId` + últimos 4 casarem com UMA conta (`bank_code` + `bank_acct_last4`), pré-seleciona e mostra "Detectado: Itaú ••••1234". Se não casar, pede para escolher (como hoje) + botão "Salvar vínculo para a próxima vez".

## 4. Sugestões aceitas (minha recomendação)
- **Sugestão 1 (recomendada)**: OFX do cartão vai DIRETO para a fatura, com revisão igual à de conta (MATCHED_AUTO / AMBIGUOUS / NEW). Na revisão, linha NEW_TX vira item de fatura, não lançamento em conta.
- **Sugestão 2**: Na fatura, selo "OFX" no item importado + FITID, para rastrear.
- **Sugestão 3**: Na tela do cartão, histórico "Últimas importações OFX deste cartão" (filtro por card_id).
- **Sugestão 4**: Se o usuário importar OFX de conta mas o arquivo for CARD, não deixa importar na conta — redireciona para a tela do cartão certo.

## Rodar
```powershell
.\scripts\run-bateria.ps1 -Bateria54
.\scripts\run-bateria.ps1 -Todos  # All inclui v54
```
