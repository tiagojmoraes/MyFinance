# v49 — GARANTIA DE ATUALIZAÇÃO (valor OU data)

## Como funciona (cadeia completa)
1. Você edita valor OU data em qualquer tela (lancamento, fluxo, parcelamentos, recorrencias, contas, etc)
2. A tela salva no banco E chama bump() — verificado: fluxo.tsx 6x, lancamento.tsx 7x, contas 7x, etc.
3. bump() faz dataVersion++ no Zustand (appStore.ts)
4. Fluxo reage: useDataEffect + dataVersion -> recarrega gm do banco (buildGroupMonths relê TUDO)
5. BalanceService.getDailyBalancesDual(month, dataVersion):
   - Se dataVersion == versão do cache -> usa cache (nada mudou)
   - Se dataVersion != versão do cache -> IGNORA cache e recalcula do zero
   => IMPOSSÍVEL devolver valor velho após bump.

## O que foi CORRIGIDO na v49
- BUG v48: flowModel tinha Map global com key só headerId, nunca invalidava -> valor/data antigos para sempre. REMOVIDO.
- BUG v48: BalanceService cache estava perdido no zip (sem dataVersion) -> recalculava sempre (seguro, mas lento). REAPLICADO com dataVersion.
- BUG v48: Fluxo não passava dataVersion -> cache não era usado. CORRIGIDO.

## O que é SEGURO e por quê
- totalsByGroupV48 (fluxo): useMemo com dependência [gm]. gm é reconstruído do banco a cada bump. Se valor/data mudou, gm muda, useMemo recalcula. Se gm não mudou, valor não mudou.
- Home useMemo: depende de [accounts] e [cardsSummary], que são setState a partir do banco após bump.
- formatBRL cache: formatter é PURO (só formata número), não guarda valor. Nunca fica stale.
- PRAGMA cache_size/mmap: cache do SQLite, invalidado pelo próprio SQLite a cada COMMIT. Nunca stale.
- promoteDuePendings guard: só pula se MESMO dia. Se mudou data para outro dia, promove.

## Teste de garantia (faça você)
1. Abra Fluxo, anote saldo do dia 15
2. Edite lançamento do dia 15: valor R$100 -> R$200 -> saldo do dia 15 + R$100 na hora
3. Edite data: dia 15 -> dia 16 -> saldo do dia 15 volta, saldo do dia 16 sobe
4. Edite parcela, fixa, fatura, transferência — mesmo comportamento
Se algum não atualizar, é porque alguma tela esqueceu bump() — me avisa qual.
