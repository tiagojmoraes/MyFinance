# BATERIA v67 — GUIA (6 BUGs + 3 MELHORIAS)

Roda no terminal (2 terminais ou depois de fechar o Expo):

```powershell
npm run test:bateria67   # só os 27 testes novos
npm run test:all         # TUDO (58 suítes / 1570 testes)
npm run typecheck        # sem erros de TypeScript
```

## O que foi corrigido e como testar no app

### BUG 1 — Saldo do dia sobreposto (Fluxo)
1. Ajustes → ligue **Orçamentos** (e "Exibir saldo por dia").
2. Fluxo: o **Saldo do dia Previsto/Efetivado** fica na linha do dia;
   **"Orçamentos: falta"** desceu para a linha de baixo — nada colide.

### BUG 2 — Layout unificado (Fluxo)
Cards de **Orçamento** e **Poupança** agora usam o MESMO esqueleto dos
lançamentos/faturas/grupos (setinha à esquerda, valor à direita,
Alterar/Excluir nos mesmos pontos). Expanda os dois para conferir.

### BUG 3 — Saldo do cabeçalho nunca some
Com Poupança/Orçamento ligados e SEM nenhum plano: o card mostra **R$ 0,00**
em vez de ficar sem valor.

### BUG 4 — Orçamento item ▸ subitem
1. Orçamento → crie "Casa R$ 100", depois subitens "Cozinha R$ 60" e
   "Lavanderia R$ 40".
2. O item Casa mostra **R$ 100 (soma dos subitens)** — o total conta 100,
   nunca 200.
3. Excluir o item com subitens orçados pergunta o destino:
   **"Só o item"** (subitens ficam) ou **"Item + subitens"**.

### BUG 5 — Categoria Débito/Crédito
No Novo Lançamento: escolha uma categoria de Despesa, troque o tipo para
Receita → a categoria é **limpa** e a lista passa a mostrar só as de Crédito
(o mesmo nas linhas do Consolidado ao trocar Débito↔Crédito).

### BUG 6 — Saldo do topo dos Cartões
1. Cartões: o valor de cada cartão = **próxima fatura em aberto** (a mais
   antiga não paga — não a mais nova).
2. Sem fatura: **R$ 0,00 · "Sem fatura em aberto"**.
3. Detalhe do cartão ganhou o card do topo com o mesmo valor.

### MELHORIA 1 — NFC-e item a item
Revisão da nota, item com sugestão: **"É esse (X%) / É outro / + Produto novo
/ Ignorar"**. Produto novo é **classificado na hora** (categorias de despesa).
Depois de vinculado: **"Incluir no estoque?"** — não: **"Apenas agora"**
(só esta nota) ou **"Sempre"** (grava NUNCA — a próxima nota nem pergunta).

### MELHORIA 2 — Catálogo de Produto
1. Cadastro → **Catálogo de Produto** (novo item do menu).
2. Lista **sem EAN** (fica só no banco), com busca, editar categoria/política.
3. **Excluir** só desvincula: notas e lançamentos ficam; a próxima nota pode
   reaprender o produto.

### MELHORIA 3 — Fluxo sem Recorrências/Parcelamentos
Os atalhos saíram do topo do Fluxo. As contas fixas e parcelas **continuam
aparecendo na lista do mês**; as telas continuam na Home.
