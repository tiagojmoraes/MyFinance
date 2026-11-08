# v57 — Produtos (Cadastros) + Memória + Vinculação durante a NF + KG vs UN — APLICADO
## O que mudou (só código + bateria, sem tela ainda)
- `src/lib/productsCatalog.ts` (novo): normalizeEan, findByEan, findByAlias, suggestByFuzzy, resolveNfItem (EAN→Alias→Fuzzy-sugestão→Pergunta), learnAlias, pantryDecisionFor, addStock/stockFor, spendByCategory.
- `src/__tests__/v57-produtos.test.ts` (novo): 19 testes, exemplo 5 SEMPRE + 2 NUNCA.
## Regras
- Produto em Cadastros → Produtos: nome, EAN, categoria, subcategoria, pantryPolicy, limite, unidade.
- Alias (CNPJ+código) invisível na tela, só no banco.
- Fuzzy só sugere, nunca unifica. EAN/Alias resolvem sozinhos.
- Vincular DURANTE a NF, 1 item por vez. Categoria 1 vez na tabela, nunca na NF.
- + Produto novo abre catálogo: nome, categoria, subcategoria, unidade, EAN, limite, despensa.
- Estoque por unidade da NF: KG e UN separados, sem conversão.
## Rodar
```
.\scripts\run-bateria.ps1 -Bateria57
.\scripts\run-bateria.ps1 -Todos
```
## Próximo passo (tela, quando você pedir)
- app/cadastro.tsx: item Produtos
- app/produtos.tsx: lista + detalhe (sem 'onde aprendeu')
- app/lancamento.tsx: durante NF, card por item novo + + Produto novo abre catálogo


# v59 — Sem EAN na tela + Fuzzy só sugere + Vinculação durante a NF
- app/produtos.tsx: SEM campo EAN (usuário não sabe o que é EAN olhando a NF). EAN continua sendo aprendido sozinho pela NF por dentro. + Produto novo abre com initialName + volta p/ revisão (returnKey).
- app/nfce/[key].tsx: SEM 'EAN:' na tela, badge 'auto · já conhecido' (sem termo técnico), fuzzy sempre 'sugestão — confirme', pergunta Despensa (Sempre/Perguntar/Nunca) durante a vinculação, '+ Produto novo' abre o catálogo (Cadastros → Produtos) em vez de criar inline.
- ProductService.resolveOrRegister: fuzzy NUNCA unifica sozinho (needsReview sempre true, sem gravar alias). EAN/Alias continuam automáticos.
- Rodar: .\scripts\run-bateria.ps1 -Bateria59
