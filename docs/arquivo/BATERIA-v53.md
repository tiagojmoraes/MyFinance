# v53 — ÁREA NUNCA PEDIDA: Despensa + Fuzzy + Backup + Dashboard + Busca + Categorias + Volume
## O que é novo (nunca pedido em v50/v51/v52)
- Despensa: ledger vs stock, não negativo, recompute, low threshold, conversão KG->G, L->ML
- Produtos Fuzzy: EAN > alias > fuzzy > novo, normalize, tokens, levenshtein
- Categorias: pai/sub, em uso, direção, pai de si mesmo
- Dashboard: série por dia, totais, min/max
- Busca: LIKE com %/_, paginação 50, termo vazio
- Backup: nome com timestamp, lista, restore (via interface)
- ID/Hash: genId 1000 sem colisão, sha256 determinístico
- Migrações: rodar 2x não duplica
- Fila: enqueueLoad em ordem, falha não trava fila
- Volume: 1000 lançamentos (saldo -100000, busca 50/página), 200 parcelas soma 200000
- NFC-e chave: DV módulo 11, UF, CNPJ, modelo, série, número
## Rodar
```powershell
.\scripts\run-bateria.ps1 -Bateria53
.\scripts\run-bateria.ps1 -Todos  # All agora inclui v53 (47 suítes)
npm run test:bateria53
```
