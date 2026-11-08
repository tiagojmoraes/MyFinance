/**
 * Rota /incluir-grupo — v22 (bug 1).
 *
 * É a MESMA tela de Novo Lançamento (app/lancamento.tsx), aberta pelo botão
 * "+Incluir" do cabeçalho do CONSOLIDADO no Fluxo. Apresentação em MODAL
 * (sobe por cima da tela) definida no layout raiz; o parâmetro `grupo` faz o
 * formulário entrar no modo "incluir no grupo": as linhas criadas (à vista,
 * fixas ou parceladas) são vinculadas ao grupo existente e passam a compor o
 * saldo dele — com exatamente o mesmo modelo e regras da tela original.
 */
export { default } from './lancamento';
