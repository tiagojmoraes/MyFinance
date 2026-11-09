# COMEÇAR AQUI — v74

## Preparar o projeto
| Erro que deu | Motivo | Como foi arrumado |
|---|---|---|
| `Need to install expo@58` + `npm error canceled` | Você estava na pasta de fora (sem `package.json`) | Essa versão tem `npm run check` que avisa se você está na pasta errada |
| `Unable to resolve query-string` | Eu removi `query-string` achando que não usava, mas o `expo-router` precisa | `package.json` agora trava `query-string@8.1.0` |
| `Invalid regular expression, js engine: hermes` | `npm install query-string` instalou a v9, que o Hermes não entende | Travado em `8.1.0` — nunca instale `query-string` sem o `@8.1.0` |
| `VirtualizeUtils` / `query-string` sumindo, cada vez um arquivo diferente | OneDrive cortando arquivo no meio do `npm install` | Checklist abaixo: pausar OneDrive antes do install |

## 1ª vez (só 1 vez)

```powershell
# 1. Entra na pasta de DENTRO (tem que ter app/ e src/)
cd "C:\Users\tiago\OneDrive\Desktop\myfinance-pantry-manager\myfinance-pantry-manager"

# 2. Pausa o OneDrive 2h (ícone lá embaixo, perto do relógio) — senão ele quebra o install

# 3. Checa tudo antes (novo na v60)
npm run check

# 4. Se o check mandar, instala
npm install

# 5. Confere a versão do query-string (tem que ser 8.x, nunca 9.x)
npm list query-string
```

## Todo dia

**Terminal — Expo:**
```powershell
npm run dev
```
Escaneie o QR code com o Expo Go.

## Testes

- `npm test` executa as suítes mantidas para os fluxos atuais e os domínios
  principais, aplicando limites de cobertura dos serviços.
- `npm run typecheck` valida os tipos.

A bateria Jest não renderiza nem automatiza todas as telas e navegações nativas.
Os limites são um piso para regras em serviços — não uma garantia de que todo
fluxo de interface foi exercitado no aparelho.

## Se der erro, olha aqui primeiro (antes de mandar print)

| O que apareceu | Faz isso |
|---|---|
| `Need to install expo@58` | Você está na pasta de fora. Rode o `cd` do passo 1. |
| `Unable to resolve query-string` | Rode: `npm uninstall query-string` + `npm install query-string@8.1.0` |
| `Invalid regular expression / hermes` | Você instalou query-string v9. Volta pra 8.1.0 (linha acima). |
| Tela vermelha no celular, outro arquivo faltando | Rode `npm run check`, depois `npm install` com o OneDrive pausado. |
| `Request Rejected` na NFC-e | A SEFAZ recusou a consulta. O app não repete nem tenta contornar o bloqueio; registre a despesa manualmente ou consulte novamente mais tarde pelo canal oficial. |

## Versões travadas (não atualiza)
- `expo ~53.0.9` — não rode `npx expo` fora da pasta, ele tenta baixar o Expo 58
- `expo-router ~5.1.11` — precisa do `query-string@8.1.0`
- `query-string 8.1.0` — a v9 quebra o Hermes
- `react-native 0.79.6` / `react 19.0.0`

## Novidades v72
- NFC-e consulta somente a página oficial pelo WebView, sem proxy de PC,
  identidade de navegador forjada ou bypass de certificado.
- Ao receber um bloqueio, a consulta para; o app não tenta trocar de canal
  nem repetir a requisição automaticamente.
- Uma instalação de produção nova começa sem cadastros ou dados de exemplo.
- Em Ajustes › Dados, “Zerar toda a base de dados” apaga registros e preferências.

## v62 — Banco novo já nasce certo + Zerar tudo
- Banco novo já nasce com `created_at`, `pantry_policy`, `cnpj`, `match_type` — sem precisar de reparo.
- Banco antigo continua sendo reparado pela v61 (migração 49).
- **Ajustes > Zerar tudo (teste)**: apaga TUDO e deixa o banco como novo, sem precisar limpar o Expo Go no celular.
- `npm run check` valida a pasta, dependências e arquivos do projeto.

## v63.1 — o projeto "quebrado" do OneDrive foi consertado
- **17 arquivos de conflito do OneDrive (`_1`/`_2`) reconciliados** — a versão mais nova de cada arquivo voltou para o nome oficial (ProductService v57, OFX de cartão v54, memo v56, icons, money v52, metro minify, tela NFC-e v59...).
- **3 crashes de tela corrigidos**: Fluxo (`gm`), Ajustes (ConfirmDialog "Zerar tudo"), saldo do dia (SQL com comentário dentro).
- `npm run check` agora **varre TODO o projeto** atrás de duplicados `_1`/`_2` (antes só olhava 4 nomes fixos).
- Migração **v50** adiciona `bank_code`/`bank_acct_last4` em bancos antigos (amarração OFX v54).
- **Se aparecer arquivo `_1`/`_2` de novo**: o OneDrive fez conflito. Rode `npm run check` — ele mostra a lista completa.

---

## Novidade v68 (o que mudou nesta versão)

| O que | Onde | Como ficou |
|---|---|---|
| Orçado • Previsto • Gasto | Fluxo › Orçamento | Expandido mostra os TRÊS números (Orçado = limite; Previsto = pendentes; Gasto = efetivados) por orçamento e no total |
| Plano cadastrado | Fluxo › Poupança | Expandido mostra o plano: nome (conta destino), modalidade, valor e guardado/falta |
| Saldo do dia | Fluxo | "Saldo do dia Previsto/Efetivado" AGORA INCORPORA orçamento e poupança (Fechar o Mês: o restante é da poupança; Mensal: o valor volta ao número). A linha "Orçamentos:" foi removida |
| Ajustes em grupos | Ajustes | PREFERENCIAS · BACKUP · DADOS · SOBRE com a setinha para expandir; NFC-e, OFX e Despensa viraram TOGGLES "incluir na tela inicial"; saíram o diagnóstico da leitura, o serviço de leitura, "Processar recorrências" e "Zerar tudo" |
| Ações rápidas | Tela inicial | Só aparece com alguma opção ativada (NFC-e/OFX/Despensa/Orçamento/Poupança) |
| Sem subtítulo | 8 telas | Cartões, Contas, Categorias, Catálogo, OFX, Despensa, Orçamento e Poupança ficaram só com o título |
| + Subcategoria inline | Categorias | O botão "+ Subcategoria" abre o campo de nome DENTRO do cartão — digitou, salvou |
| Catálogo só visualiza | Catálogo de Produto | −1/+1/Lixeira saíram (são da Despensa); o lápis abre a TELA DE EDIÇÃO do produto (novo: /produtos/novo) |
| Repetir | Novo Lançamento | Fixo e Parcelado (Crédito/Débito) ganham "Repetir": Semanal, Mensal, Bimestral, Trimestral, Semestral, Anual |
| QR no lançamento | Novo Lançamento | "Colar e consultar" ficou BRANCO no modal escuro; com nota lida, o campo "Categoria (opcional)" sai (a categoria vem de cada item) |
| Desempenho | Geral | Saldo do dia memoizado; linhas do Fluxo/Despensa/Catálogo memoizadas; Orçamento/Poupança só recalculam quando muda mês ou lançamento |

---

## Novidade v67 (o que mudou nesta versão)

| O que | Onde | Como ficou |
|---|---|---|
| Cabeçalho do dia (Fluxo) | Fluxo | Saldo Previsto/Efetivado tem LINHA PRÓPRIA; "Orçamentos: falta" desceu para a linha de baixo — nada mais se sobrepõe |
| Linhas do Fluxo | Fluxo | TUDO usa o mesmo esqueleto (LancamentoRow): lançamento, parcela, grupo, fatura e os cards Orçamento/Poupança |
| Saldo do cabeçalho | Fluxo | Sem dados mostra R$ 0,00 — o valor não some mais dos cards Orçamento/Poupança |
| Orçamento item ▸ subitem | Orçamento | Pai = SOMA dos subitens (R$ 100 = 60 + 40), sem contar em dobro; excluir pergunta: só o item, ou item + subitens |
| Categoria Débito/Crédito | Novo Lançamento | Cada lado com a sua lista; trocar o lado LIMPA a categoria que não pertence ao novo tipo |
| Saldo no topo dos Cartões | Cartões | = PRÓXIMA fatura em aberto (a mais antiga não paga); sem fatura: R$ 0,00 · "Sem fatura em aberto" — cada cartão com o seu |
| NFC-e item a item | Revisão da nota | Sugestão fuzzy com "É esse / É outro / + Produto novo / Ignorar"; novo produto é classificado na hora (categoria de despesa); pergunta "Incluir no estoque?" — não: "Apenas agora" ou "Sempre" (NUNCA, gravado) |
| Catálogo de Produto | Cadastro | Entrou no menu do Cadastro com o nome "Catálogo de Produto"; lista SEM EAN; excluir SÓ desvincula (notas/lançamentos ficam) |
| Recorrências/Parcelamentos | Fluxo | Atalhos saíram da tela Fluxo (os lançamentos continuam na lista; telas acessíveis pela Home) |
