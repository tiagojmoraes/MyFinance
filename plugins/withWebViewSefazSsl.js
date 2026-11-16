/**
 * v26 — Config plugin (Expo): "SSL error: The certificate authority is not
 * trusted" ao abrir a NFC-e da SEFAZ-SP no navegador interno.
 *
 * Causa: o portal da SEFAZ-SP usa uma cadeia de certificados (ICP-Brasil) que
 * o repositório de certificados do Android nem sempre reconhece, e o
 * react-native-webview CANCELA incondicionalmente qualquer erro de SSL.
 *
 * Solução com o MENOR risco possível: o plugin altera o RNCWebViewClient
 * (Java) para aceitar SOMENTE o erro "autoridade não confiável"
 * (SSL_UNTRUSTED) e SOMENTE em endereços https do domínio fazenda.sp.gov.br.
 * Qualquer outro erro (data inválida, nome diferente, expirado) e qualquer
 * outro site continuam BLOQUEADOS, como antes. O app só LÊ a nota (página
 * pública); nenhuma senha ou dado pessoal trafega nesse WebView.
 *
 * Roda no `expo prebuild` / EAS Build — é preciso gerar um NOVO build do app.
 */
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

const MARKER = 'MYFINANCE_SEFAZ_SSL';
const TARGET = path.join(
  'react-native-webview', 'android', 'src', 'main', 'java',
  'com', 'reactnativecommunity', 'webview', 'RNCWebViewClient.java'
);

const GUARD = `        // ${MARKER}: aceita SÓ "CA não confiável" em https://*.fazenda.sp.gov.br
        try {
            if (error.getPrimaryError() == SslError.SSL_UNTRUSTED) {
                android.net.Uri sefazUri = android.net.Uri.parse(error.getUrl());
                String sefazHost = sefazUri.getHost();
                if ("https".equalsIgnoreCase(sefazUri.getScheme()) && sefazHost != null
                        && (sefazHost.equalsIgnoreCase("fazenda.sp.gov.br")
                            || sefazHost.toLowerCase().endsWith(".fazenda.sp.gov.br"))) {
                    handler.proceed();
                    return;
                }
            }
        } catch (Exception ignored) {
            // em dúvida, segue o comportamento padrão (cancelar)
        }
`;

function patchJava(source) {
  if (source.includes(MARKER)) return source; // idempotente
  const sig = /public void onReceivedSslError\(final WebView webView, final SslErrorHandler handler, final SslError error\) \{\n/;
  if (!sig.test(source)) {
    throw new Error('[withWebViewSefazSsl] onReceivedSslError não encontrado — versão do react-native-webview mudou');
  }
  return source.replace(sig, (m) => m + GUARD);
}

function resolveJava(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'node_modules', TARGET),
    path.join(projectRoot, '..', 'node_modules', TARGET),
    path.join(projectRoot, '..', '..', 'node_modules', TARGET),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const withWebViewSefazSsl = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      const file = resolveJava(cfg.modRequest.projectRoot);
      if (!file) throw new Error('[withWebViewSefazSsl] RNCWebViewClient.java não encontrado');
      fs.writeFileSync(file, patchJava(fs.readFileSync(file, 'utf8')));
      return cfg;
    },
  ]);

module.exports = withWebViewSefazSsl;
module.exports.patchJava = patchJava;
module.exports.MARKER = MARKER;
