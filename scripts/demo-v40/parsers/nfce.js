"use strict";
/**
 * Parser NFC-e — SEFAZ São Paulo (v18, "leitura resiliente" — ARQ-008).
 *
 * O QR Code da NFC-e aponta para o portal da SEFAZ-SP
 * (ex.: https://www.nfce.fazenda.sp.gov.br/qrcode?p=<chave>|2|1|1|<assinatura>).
 * A página pública é raspada com regexes TOLERANTES a variações de layout:
 *  - Header: estabelecimento (nome), CNPJ, data/hora de emissão,
 *    valor total, valor pago e desconto.
 *  - Itens: descrição (nome do produto), código do produto (GTIN/EAN ou código
 *    interno da loja), quantidade (qtde), unidade de medida (un) e valor total.
 *
 * Regras do v18 (bug 6 — NFC-e ponta a ponta):
 *  - A URL ESCANEADA é sagrada: o reprocessamento usa exatamente o link do QR
 *    (com a assinatura); sem ele a SEFAZ-SP pode negar a página.
 *  - Fallbacks de URL para chave manual (portal público atual + legado).
 *  - CNPJ é extração OBRIGATÓRIA (formatado 00.000.000/0000-00 ou 14 dígitos).
 *  - Falha no parse de itens NUNCA derruba a transação financeira.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractAccessKey = extractAccessKey;
exports.accessKeyDv = accessKeyDv;
exports.checkAccessKey = checkAccessKey;
exports.nfceKeyDescribe = nfceKeyDescribe;
exports.sanitizeSefazUrl = sanitizeSefazUrl;
exports.isFirewallRejectionPage = isFirewallRejectionPage;
exports.isAxureNfcePage = isAxureNfcePage;
exports.looksLikeNfcePage = looksLikeNfcePage;
exports.isSefazUrl = isSefazUrl;
exports.buildSpConsultUrl = buildSpConsultUrl;
exports.buildSpQrUrl = buildSpQrUrl;
exports.buildLegacyConsultUrl = buildLegacyConsultUrl;
exports.listConsultUrls = listConsultUrls;
exports.normalizeCnpj = normalizeCnpj;
exports.parseNfceHeader = parseNfceHeader;
exports.convertToBaseUnit = convertToBaseUnit;
exports.pageHasItems = pageHasItems;
exports.parseNfceItemsByClass = parseNfceItemsByClass;
exports.parseNfceItemsAxure = parseNfceItemsAxure;
exports.parseNfceItems = parseNfceItems;
const CHAVE_RE = /\d{44}/;
/** Chave de 44 dígitos a partir de URL do QR Code ou texto puro. */
function extractAccessKey(input) {
    const trimmed = input.trim();
    // Chave pura
    const pure = trimmed.match(new RegExp(`\\b${CHAVE_RE.source}\\b`));
    if (pure)
        return pure[0];
    // Parâmetros comuns de URL: p=n=chave|ts|valor / chaveAcesso / chave / chNFe
    try {
        const url = new URL(trimmed);
        const candidates = [
            url.searchParams.get('p'),
            url.searchParams.get('chaveAcesso'),
            url.searchParams.get('chave'),
            url.searchParams.get('chNFe'),
            url.searchParams.get('chNf-e'),
        ];
        for (const c of candidates) {
            if (!c)
                continue;
            const decoded = decodeURIComponent(c);
            const inside = decoded.match(CHAVE_RE);
            if (inside)
                return inside[0];
        }
        // Chave embutida em qualquer parte da URL
        const inUrl = trimmed.match(CHAVE_RE);
        if (inUrl)
            return inUrl[0];
    }
    catch {
        // não é URL — segue
    }
    return null;
}
/* ════════════════════════════════════════════════════════════════════
 * v40 — VALIDAÇÃO DA CHAVE DE ACESSO (diagnóstico de causa raiz).
 *
 * A chave NFe/NFC-e de 44 dígitos tem layout oficial:
 *   cUF(2) · AAMM(4) · CNPJ(14) · modelo(2) · série(3) · nº(9) ·
 *   tpEmis(1) · cNF(8) · cDV(1)
 * O DV é módulo 11 com pesos 2..9 (da direita para a esquerda, ciclando):
 *   resto = soma % 11;  DV = (resto 0 ou 1) ? 0 : 11 - resto.
 * Fórmula provada contra a chave real do cupom Fonseca
 * 352610…3362 (DV=2 — scripts/prova-dv11.mjs).
 *
 * Com isto, UM dígito errado ao digitar a chave é apontado na hora
 * (ETAPA 2/8 do terminal) — sem gastar 20 s com o portal para falhar.
 * ════════════════════════════════════════════════════════════════════ */
/** Código IBGE da UF (2 primeiros dígitos da chave). */
const UF_POR_CODIGO = {
    '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO',
    '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL',
    '28': 'SE', '29': 'BA', '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP', '41': 'PR',
    '42': 'SC', '43': 'RS', '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF',
};
/** DV módulo 11 (pesos 2..9 da direita para a esquerda, ciclando). */
function accessKeyDv(key43) {
    let soma = 0;
    let peso = 2;
    for (let i = key43.length - 1; i >= 0; i--) {
        soma += Number(key43[i]) * peso;
        peso = peso === 9 ? 2 : peso + 1;
    }
    const resto = soma % 11;
    return resto <= 1 ? 0 : 11 - resto;
}
/** Valida e decodifica a chave de 44 dígitos — pura, sem rede, testável. */
function checkAccessKey(key) {
    const problems = [];
    const digits = /^\d+$/.test(key) ? key.length : (key.match(/\d/g) ?? []).length;
    const onlyDigits = key.replace(/\D/g, '');
    const base = {
        key,
        digits,
        ok: false,
        dvOk: false,
        dvInformed: null,
        dvExpected: null,
        ufCode: null,
        ufName: null,
        year: null,
        month: null,
        cnpj: null,
        modelo: null,
        modeloName: null,
        serie: null,
        numero: null,
        problems,
    };
    if (onlyDigits.length !== 44) {
        problems.push(`chave tem ${onlyDigits.length} dígito(s) — o padrão da NFC-e é 44; confira se copiou a chave inteira`);
        return base;
    }
    const dvInformed = Number(onlyDigits[43]);
    const dvExpected = accessKeyDv(onlyDigits.slice(0, 43));
    base.dvInformed = dvInformed;
    base.dvExpected = dvExpected;
    base.dvOk = dvInformed === dvExpected;
    if (!base.dvOk) {
        problems.push(`DV da chave NÃO confere (esperado ${dvExpected}, informado ${dvInformed}) — provável dígito errado ao digitar/copiar`);
    }
    const ufCode = onlyDigits.slice(0, 2);
    base.ufCode = ufCode;
    base.ufName = UF_POR_CODIGO[ufCode] ?? null;
    if (!base.ufName) {
        problems.push(`código de UF "${ufCode}" não é de nenhuma unidade federativa — chave inválida`);
    }
    const year = Number(onlyDigits.slice(2, 4)) + 2000;
    const month = Number(onlyDigits.slice(4, 6));
    base.year = year;
    base.month = month;
    if (month < 1 || month > 12) {
        problems.push(`mês de emissão na chave ("${onlyDigits.slice(4, 6)}") é inválido — chave mal copiada`);
    }
    const cnpjDigits = onlyDigits.slice(6, 20);
    base.cnpj = `${cnpjDigits.slice(0, 2)}.${cnpjDigits.slice(2, 5)}.${cnpjDigits.slice(5, 8)}/${cnpjDigits.slice(8, 12)}-${cnpjDigits.slice(12)}`;
    const modelo = onlyDigits.slice(20, 22);
    base.modelo = modelo;
    base.modeloName = modelo === '65' ? 'NFC-e' : modelo === '55' ? 'NFe' : null;
    if (modelo === '55') {
        problems.push('a chave é de NFe (modelo 55) — o leitor do app lê NFC-e (modelo 65); escaneie o QR da NFC-e');
    }
    else if (modelo !== '65') {
        problems.push(`modelo "${modelo}" da chave não é NFC-e (65) — o portal pode recusar a consulta`);
    }
    base.serie = onlyDigits.slice(22, 25);
    base.numero = onlyDigits.slice(25, 34);
    base.ok = base.dvOk && !!base.ufName && modelo === '65';
    return base;
}
/** Uma linha resumo da validação (para a ETAPA 2/8 do terminal). */
function nfceKeyDescribe(c) {
    const bits = [
        c.dvOk ? `DV ✓ (${c.dvExpected})` : `DV ✗ (esp. ${c.dvExpected}, info ${c.dvInformed})`,
        c.ufName ? `UF ${c.ufCode}=${c.ufName}` : `UF ${c.ufCode ?? '?'}=?`,
        c.month != null ? `emissão ${c.year}-${String(c.month).padStart(2, '0')}` : null,
        c.cnpj ? `CNPJ ${c.cnpj}` : null,
        c.modeloName ? `modelo ${c.modelo} (${c.modeloName})` : `modelo ${c.modelo ?? '?'}`,
        c.numero ? `nº ${c.numero}` : null,
        `série ${c.serie ?? '?'}`,
    ].filter(Boolean);
    return bits.join(' · ');
}
/**
 * v23 (bug "The requested URL was rejected"): SANITIZA a URL escaneada do QR.
 *
 * O conteúdo do QR da SEFAZ-SP traz `p=<chave>|2|...` com BARRAS VERTICAIS
 * CRUAS. O Chrome codifica `|` para %7C na rede; o WebView do Android pode
 * enviar o caractere cru — e o firewall F5/BIG-IP do portal REJEITA na hora
 * ("The requested URL was rejected. Please consult with your administrator.",
 * com "Your support ID"). Aqui codificamos APENAS os caracteres ilegais em
 * URL (RFC 3986) preservando o que já está válido (%, &, =, +, letras...):
 * espaço→%20, |→%7C, "→%22, <→%3C, >→%3E, `→%60, ^→%5E, {→%7B, }→%7D, \→%5C.
 */
function sanitizeSefazUrl(raw) {
    const trimmed = raw.trim();
    const qIdx = trimmed.indexOf('?');
    if (qIdx < 0)
        return trimmed;
    const base = trimmed.slice(0, qIdx);
    const query = trimmed.slice(qIdx + 1);
    const fixed = query.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@%/?]/g, (ch) => encodeURIComponent(ch));
    return `${base}?${fixed}`;
}
/**
 * v23: a página exibida é o BLOQUEIO do firewall (não é o desafio JavaScript,
 * que resolve sozinho)? Texto típico: "The requested URL was rejected. Please
 * consult with your administrator." + "Your support ID is: ...".
 */
function isFirewallRejectionPage(html) {
    if (/Valor\s+(?:Total|a\s+Pagar)|Nome\s+Empresarial/i.test(html))
        return false; // é a nota
    return /requested\s+URL\s+was\s+rejected|Your\s+support\s+ID|Request\s+Rejected|Access\s+Denied/i.test(html);
}
/**
 * v30: LAYOUT AXURE — a página de consulta por QR da SEFAZ-SP é gerada pelo
 * Axure RP e os dados ficam em <div id='uNN'> com ids numéricos
 * (u20_div = estabelecimento, u25 = CNPJ, u40 = número/série/emissão,
 * u45 = valor a pagar, u60 = forma de pagamento) e os ITENS numa
 * <table id='grdItens'> com 2 células por linha. Detectado por qualquer
 * marcador desses (aspas simples ou duplas, com ou sem sufixo _div).
 */
function isAxureNfcePage(html) {
    return /id=["']u(?:20|25|40|45|50|60)(?:_div)?["']|id=["']grdItens["']/i.test(html);
}
/**
 * v30: texto de um <div id='uNN(_div)'> do layout Axure (aspas tolerantes).
 * Devolve o texto puro (tags removidas, entidades decodificadas) ou null.
 */
function axureDivText(html, id) {
    const re = new RegExp(`<div[^>]*id=["']${id}(?:_div)?["'][^>]*>([\\s\\S]*?)</div>`, 'i');
    const m = html.match(re);
    if (!m)
        return null;
    const text = decodeEntities(m[1].replace(/<[^>]*>/g, ' '));
    return text || null;
}
/**
 * v22/v23 (movida do NfceWebFetch p/ cá — lógica pura, testável sem RN):
 * o HTML capturado JÁ é a página da nota?
 */
function looksLikeNfcePage(html) {
    // Página do desafio do F5 — ainda NÃO é a nota
    if (/TSPD|APM_DO_NOT_TOUCH|Request Rejected/i.test(html) &&
        !/Valor\s+(Total|a\s+Pagar)|Nome\s+Empresarial/i.test(html)) {
        return false;
    }
    // Página da nota: contém rótulos conhecidos do portal da SEFAZ-SP
    // v22: marcador "NFCe" sem hífen também conta (o portal varia o layout)
    // v30: o layout Axure (QR) não usa os rótulos clássicos — os ids uNN/grdItens
    // também provam que é a nota.
    const isNfce = /NFC-?e|Nota\s+Fiscal\s+(?:do|de)\s+Consumidor/i.test(html);
    const hasData = /Nome\s+Empresarial|Raz[aã]o\s+Social|Valor\s+Total|Valor\s+a\s+Pagar|CNPJ|Dados\s+da\s+NFC-?e|Informa[çc][õo]es?\s+da\s+Nota|Protocolo\s+de\s+Autoriza/i.test(html);
    if (isNfce && hasData)
        return true;
    // v30: página Axure com dados da nota (u20/u25/u45 ou grdItens)
    return /NFC-?e/i.test(html) && isAxureNfcePage(html);
}
/** É uma URL do portal da SEFAZ (QR Code ou consulta pública)? */
function isSefazUrl(input) {
    return /nfce?\.fazenda\.|sefaz\./i.test(input) && /^https?:\/\//i.test(input.trim());
}
/**
 * v18: URL pública de consulta completa da NFC-e SP a partir da chave.
 * Portal público ATUAL (NFCeConsultaPublica) — o antigo consultacompleta.aspx
 * foi descontinuado pela SEFAZ-SP e não responde mais.
 */
function buildSpConsultUrl(accessKey) {
    return `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaPublica.aspx?chaveAcesso=${accessKey}`;
}
/**
 * v32: link do QR montado a partir da CHAVE (sem escanear). O QR da NFC-e-SP
 * atual usa p=chave|3|1 (versão 3 do QR, ambiente 1 = produção). Sonda real do
 * usuário (PowerShell, out/2025) confirmou: esse link responde HTTP 200 com a
 * página COMPLETA da nota (~25 KB). O `|` vai codificado (%7C) — mesmo valor
 * que o Chrome envia na rede.
 */
function buildSpQrUrl(accessKey) {
    return `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${accessKey}%7C3%7C1`;
}
/** v18: URL legada (descontinuada — NÃO entra mais na fila de tentativas). */
function buildLegacyConsultUrl(accessKey) {
    return `https://nfce.fazenda.sp.gov.br/consultacompleta.aspx?chaveAcesso=${accessKey}`;
}
/**
 * v18: CANDIDATOS de URL em ordem de tentativa.
 *  1. A URL escaneada do QR Code (contém a assinatura do QR — caminho oficial),
 *     SANITIZADA (v23 — sem caracteres ilegais que o firewall rejeita);
 *     só a chave colada? monta o link do QR completo p=chave|3|1 (v32);
 *  2. Portal público atual com a chave.
 * v32: o legado consultacompleta.aspx SAIU da fila — descontinuado pela
 * SEFAZ-SP e provado sem resposta ("Impossível conectar-se" no PC e erro de
 * CERTIFICADO no celular — só atrasava 2–5 s e confundia o diagnóstico).
 */
function listConsultUrls(input, accessKey) {
    const urls = [];
    // v39.1 (experiência comprovada no chat com cupom real — Fonseca 31/10/2026):
    // o QR impresso no cupom pode trazer domínio CURTO (nfce.fazenda.sp.gov/qrcode
    // — que nem resolve no DNS!) ou variantes antigas do link. O canal que
    // FUNCIONA é sempre o canônico .br (ConsultaQRCode.aspx?p=chave|3|1): ele vai
    // PRIMEIRO; a URL crua escaneada fica de reserva; ConsultaPublica por último.
    urls.push(buildSpQrUrl(accessKey));
    const trimmed = input.trim();
    if (/^https?:\/\//i.test(trimmed)) {
        const sanitized = sanitizeSefazUrl(trimmed);
        if (!urls.some((u) => u === sanitized))
            urls.push(sanitized);
    }
    const pub = buildSpConsultUrl(accessKey);
    if (!urls.some((u) => u === pub))
        urls.push(pub);
    return urls;
}
function decodeEntities(text) {
    return text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&ccedil;/gi, 'ç')
        .replace(/&atilde;/gi, 'ã')
        .replace(/&oacute;/gi, 'ó')
        .replace(/&eacute;/gi, 'é')
        .replace(/&iacute;/gi, 'í')
        .replace(/&aacute;/gi, 'á')
        .replace(/&acirc;/gi, 'â')
        .replace(/&ecirc;/gi, 'ê')
        .replace(/&ocirc;/gi, 'ô')
        .replace(/&uacute;/gi, 'ú')
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * v18: extrai o VALOR que vem logo depois de um rótulo na página SEFAZ.
 * Suporta os três formatos conhecidos:
 *  1. <span class="label">RÓTULO</span> <span class="text">VALOR</span>  (legado)
 *  2. <label>RÓTULO:</label> ... <span class="value">VALOR</span>        (novo)
 *  3. RÓTULO: VALOR (texto corrido, células de tabela etc.)
 */
function textAfterLabel(html, labelPattern) {
    // v20 (correção): valor na MESMA linha do rótulo — "<div>Valor Pago: R$ 20,00</div>"
    // (layout comum da SEFAZ-SP). Antes a captura caía no `[^>]*` do ramo (1) e
    // devolvia só whitespace → Valor Total/Pago viravam null.
    // Exige ":" logo após o rótulo — sem isso "Valor total do item: R$ 15,98"
    // prefixava o rótulo do cabeçalho e roubava o valor.
    const reSameNode = new RegExp(`${labelPattern.source}\\s*:\\s*([^<>·]{2,160})<`, 'i');
    const m0 = html.match(reSameNode);
    if (m0) {
        // v25: corta o valor no início de um PRÓXIMO rótulo engolido pela captura
        // ("R$ 10,00 Valor a Pagar: R$ 10,00" → "R$ 10,00") — sem isso o
        // parseMoneyToCents juntava os dois valores e arredondava o centavo.
        let v = decodeEntities(m0[m0.length - 1]);
        const cutAt = v.search(/\bValor\s+(?:a\s+Pagar|Pago|Total|dos?\s+Produtos)\b/i);
        if (cutAt > 0)
            v = v.slice(0, cutAt);
        v = v.trim();
        if (v && !/^(sim|não|nao|-|—)$/i.test(v))
            return v;
    }
    // (1) e (2): rótulo, quaisquer tags, e um nó de texto
    const re = new RegExp(`${labelPattern.source}\\s*:?[^>]*>(?:\\s*<[^>]+>)*\\s*([^<>]{2,160})<`, 'i');
    const m = html.match(re);
    if (m) {
        const v = decodeEntities(m[m.length - 1]).trim();
        if (v && !/^(sim|não|nao|-|—)$/i.test(v))
            return v;
    }
    // (2b) rótulo dentro de tag, valor no próximo <span class="text|value|...">
    const reSpan = new RegExp(`${labelPattern.source}[^<]*<[^>]*>\\s*<span[^>]*class="(?:text|value)"[^>]*>([^<]+)`, 'i');
    const m2 = html.match(reSpan);
    if (m2)
        return decodeEntities(m2[m2.length - 1]).trim() || null;
    return null;
}
function parseMoneyToCents(raw) {
    const m = raw.replace(/[^\d,.-]/g, '');
    if (!m)
        return null;
    const br = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(m) || /,\d{2}$/.test(m);
    const normalized = br ? m.replace(/\./g, '').replace(',', '.') : m;
    const v = Number.parseFloat(normalized);
    if (!Number.isFinite(v))
        return null;
    return Math.round(v * 100);
}
/** v18: normaliza o CNPJ para 00.000.000/0000-00 (retorna null se inválido). */
function normalizeCnpj(raw) {
    if (!raw)
        return null;
    const digits = raw.replace(/\D/g, '');
    if (digits.length !== 14)
        return null;
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}
/** dd/mm/aaaa hh:mm:ss -> ISO local (tratado como hora de São Paulo ~UTC-3). */
function parseBrDateTime(raw) {
    const m = raw.match(/(\d{2})\/(\d{2})\/(\d{4})[ ,]+(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m)
        return null;
    const [, d, mo, y, h, mi, s] = m;
    // São Paulo = UTC-3 (fixo desde 2019)
    const iso = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)));
    iso.setUTCHours(iso.getUTCHours() + 3);
    return iso.toISOString();
}
/** Extrai o Header da página da NFC-e (Passo 1 do ARQ-008). */
function parseNfceHeader(html, accessKey) {
    // Estabelecimento — rótulos usados pelos portais da SEFAZ-SP
    // v30: layout Axure usa <div id='u20_div'> (aspas simples, sufixo _div)
    const storeName = (html.match(/<div[^>]*(?:id="u20"|class="[^"]*\btxtTopo\b[^"]*")[^>]*>([^<]{2,160})</i)?.[1]
        ? decodeEntities(html.match(/<div[^>]*(?:id="u20"|class="[^"]*\btxtTopo\b[^"]*")[^>]*>([^<]{2,160})</i)[1])
        : null) ??
        axureDivText(html, 'u20') ??
        textAfterLabel(html, /Nome\s+Empresarial/i) ??
        textAfterLabel(html, /Raz[aã]o\s+Social/i) ??
        textAfterLabel(html, /Nome\s+(?:de\s+)?Fantasia/i) ??
        textAfterLabel(html, /Emitente\s*:?/i);
    // CNPJ — formatado primeiro; senão 14 dígitos junto ao rótulo
    let cnpj = null;
    const formatted = html.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
    if (formatted) {
        cnpj = normalizeCnpj(formatted[0]);
    }
    else {
        const re = new RegExp('CNPJ[^0-9]{0,40}(\\d{14})', 'i');
        const m = html.match(re);
        cnpj = m ? normalizeCnpj(m[1]) : null;
    }
    const issuedRaw = textAfterLabel(html, /Data\s+e\s+Hora\s+(?:da\s+)?(?:Emiss[aã]o|de\s+Emiss[aã]o)/i) ??
        textAfterLabel(html, /Data\s+de\s+Emiss[aã]o/i) ??
        textAfterLabel(html, /Emiss[aã]o\s*:?/i);
    // Fallback: qualquer data/hora dd/mm/aaaa hh:mm na página
    const issuedAt = (issuedRaw ? parseBrDateTime(issuedRaw) : null) ??
        (() => {
            const m = html.match(/(\d{2}\/\d{2}\/\d{4}[ ,]+\d{2}:\d{2}(?::\d{2})?)/);
            return m ? parseBrDateTime(m[1]) : null;
        })();
    const gross = 
    // v30 (layout Axure): "Valor a pagar R$:131,47" — o "R$:" entre o rótulo e o
    // valor quebra o textAfterLabel (exige ":" logo após o rótulo) e o fallback
    // genérico acabaria lendo o número do nó SEGUINTE (forma de pagamento).
    // A regex dedicada exige o número colado ao rótulo — nos layouts clássicos
    // o valor vem em outro nó e ela nem dispara.
    html.match(/Valor\s+a\s+pagar\s*(?:R\$)?\s*:?\s*([\d.]+,\d{2}|\d+,\d{2})/i)?.[1] ??
        textAfterLabel(html, /Valor\s+Total\b/i) ??
        textAfterLabel(html, /Valor\s+Total\s+dos?\s+Produtos/i) ??
        textAfterLabel(html, /Valor\s+a\s+Pagar/i);
    const paid = textAfterLabel(html, /Valor\s+(?:Pago|Recebido)\b/i) ?? gross;
    const discount = textAfterLabel(html, /Desconto\b/i);
    const grossTotalCents = gross ? parseMoneyToCents(gross) : null;
    const amountPaidCents = paid ? parseMoneyToCents(paid) : null;
    const discountCents = discount ? (parseMoneyToCents(discount) ?? 0) : 0;
    return {
        accessKey,
        storeName,
        cnpj,
        issuedAt,
        grossTotalCents,
        amountPaidCents,
        discountCents,
    };
}
/** Converte unidade da nota para unidade base do catálogo (G|ML|UN). */
function convertToBaseUnit(qty, unitOriginal) {
    const unit = (unitOriginal || 'UN').trim().toUpperCase();
    const factorMap = {
        G: { factor: 1, base: 'G' },
        GR: { factor: 1, base: 'G' },
        GRAMAS: { factor: 1, base: 'G' },
        KG: { factor: 1000, base: 'G' },
        KGS: { factor: 1000, base: 'G' },
        QUILO: { factor: 1000, base: 'G' },
        QUILOS: { factor: 1000, base: 'G' },
        ML: { factor: 1, base: 'ML' },
        MILILITRO: { factor: 1, base: 'ML' },
        MILILITROS: { factor: 1, base: 'ML' },
        L: { factor: 1000, base: 'ML' },
        LT: { factor: 1000, base: 'ML' },
        LITRO: { factor: 1000, base: 'ML' },
        LITROS: { factor: 1000, base: 'ML' },
        UN: { factor: 1, base: 'UN' },
        UND: { factor: 1, base: 'UN' },
        UNIDADE: { factor: 1, base: 'UN' },
        UNIDADES: { factor: 1, base: 'UN' },
        CX: { factor: 1, base: 'UN' },
        PC: { factor: 1, base: 'UN' },
    };
    const entry = factorMap[unit];
    if (!entry)
        return null;
    return { deltaBase: Math.round(qty * entry.factor), baseUnit: entry.base };
}
/** Rótulos de metadados (nunca são descrição de produto). */
const LABEL_RE = /^(c[oó]digo|c[oó]digo\s*(\(\s*gtin\/ean\s*\))?|c[oó]digo\s+do\s+produto\s*(\(\s*gtin\/ean\s*\))?|qtde|qtde\.\s*total|quantidade|qtde\s+total\s+de\s+itens|unidade|unidade\s+comercial|un\.?\s*medida|valor|valor\s+total|valor\s+total\s+do\s+item|r\$|ncm|cfop|csosn|cst|item\s*\d*|descri[çc][aã]o|descri[çc][aã]o\s+do\s+(produto|item)|gtin\/ean|eaut|eann)\s*$/i;
/** Rótulos do CABEÇALHO da nota (nunca são itens). */
const HEADER_LABEL_RE = /^(nome|nome\s+de\s+fantasia|raz[aã]o\s+social|endere[çc]o|bairro|município|cep|tele?fone|data|data\s+e\s+hora|emiss[aã]o|cnpj|ie|inscri[çc][aã]o|n[úu]mero|s[ée]rie|protocolo|ambiente|chave(\s+de\s+acesso)?|conting[êe]ncia|consumidor|total\s+de\s+itens|valor\s+total|valor\s+pago|valor\s+a\s+pagar|forma\s+de\s+pagamento|dinheiro|cart[aã]o|desconto|troco|tributos\s+totais)/i;
/** Número de quantidade no formato da SEFAZ (ex.: "2,0000 UN"). */
const QTY_TOKEN_RE = /^(\d{1,6}(?:[.,]\d{1,4})?)\s*([A-Za-zÇÇÃÊÓ]{1,6})?$/;
/** Valor monetário "R$ 1.234,56". */
const MONEY_TOKEN_RE = /^(?:r\$|rs)?\s*\d{1,3}(?:\.\d{3})*,\d{2}$/i;
/**
 * v25: linha de CABEÇALHO da nota (nome do estabelecimento, CNPJ, emissão,
 * protocolo, chave, valor TOTAL da nota) — nunca é um item. Antes, no layout
 * em que o cabeçalho vinha numa <tr> (legado), a linha virava um ITEM FANTASMA
 * com a descrição da loja e o VALOR TOTAL da nota como preço (o usuário via um
 * "produto" com o valor da compra inteira na revisão).
 */
const HEADER_ROW_RE = /(Nome\s+Empresarial|Nome\s+de\s+Fantasia|Raz[aã]o\s+Social|CNPJ|Data\s+e\s+Hora\s+da\s+Emiss[aã]o|Data\s+de\s+Emiss[aã]o|Protocolo\s+de\s+Autoriza|Chave\s+de\s+Acesso|Dados\s+da\s+NFC-?e|Informa[çc][õo]es?\s+da\s+Nota|Valor\s+Total\s+da\s+Nota)/i;
/**
 * v26: a página JÁ traz a lista de itens renderizada? Usado pelo navegador
 * interno para NÃO entregar a nota só com o cabeçalho (os itens da SEFAZ-SP
 * podem aparecer alguns instantes depois do cabeçalho).
 */
function pageHasItems(html) {
    // v30: a tabela grdItens do layout Axure também é lista de itens
    return /id="tabResult"|class="txtTit"|class="Rqtd"|class="RvlUnit"|Qtde\.?\s*total\s*de\s*itens|C[oó]digo\s+do\s+produto|id=["']grdItens["']/i.test(html);
}
/**
 * v26 (bug "a NFC-e não retorna os itens"): leitura por CLASSES do layout
 * público atual da SEFAZ-SP (NFCeConsultaPublica / ConsultaQRCode), em que
 * cada item é UMA linha:
 *   <tr id="Item + 1"><td><span class="txtTit">DESCRIÇÃO</span>
 *     <span class="RCod">(Código: 123 )</span><br/>
 *     <span class="Rqtd"><strong>Qtde.:</strong>2,0000</span>
 *     <span class="RUN"><strong>UN: </strong>UN</span>
 *     <span class="RvlUnit"><strong>Vl. Unit.:</strong> 4,99</span></td>
 *   <td class="txtTit noWrap">Vl. Total<br/><span class="valor">9,98</span></td></tr>
 * O leitor genérico (por rótulos) achava descrição e quantidade, mas perdia
 * valor do item ("Vl. Total" sem "R$"), unidade ("UN:") e código da loja.
 */
function parseNfceItemsByClass(html) {
    const items = [];
    const rows = html.split(/<tr/i).slice(1);
    const textOf = (frag) => decodeEntities(frag.replace(/<[^>]*>/g, ' '));
    for (const row of rows) {
        const desc = row.match(/<span[^>]*class="[^"]*\btxtTit\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        if (!desc)
            continue;
        const hasItemMarkers = /class="[^"]*\b(?:Rqtd|RUN|RvlUnit|valor)\b/i.test(row);
        if (!hasItemMarkers)
            continue;
        const description = textOf(desc[1]);
        if (!description || description.length < 2)
            continue;
        let ean = null;
        let storeCode = null;
        const cod = row.match(/<span[^>]*class="[^"]*\b(?:RCod|txtCod)\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        if (cod) {
            const m = textOf(cod[1]).match(/C[oó]digo[^:]{0,40}:\s*([A-Za-z0-9][A-Za-z0-9-]{0,24})/i);
            if (m) {
                if (/^\d{8}$|^\d{12,14}$/.test(m[1]))
                    ean = m[1];
                else
                    storeCode = m[1];
            }
        }
        const spanText = (cls) => {
            const m = row.match(new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/span>`, 'i'));
            if (!m)
                return null;
            // descarta o rótulo (<strong>Qtde.:</strong>) e fica com o valor
            let t = decodeEntities(m[1].replace(/<strong[^>]*>[\s\S]*?<\/strong>/gi, ' ').replace(/<[^>]*>/g, ' '));
            // layout com o rótulo DENTRO do span ("Qtde. total de itens: 2,0000"): fica só o valor
            const colon = t.lastIndexOf(':');
            if (colon >= 0 && t.slice(colon + 1).trim())
                t = t.slice(colon + 1).trim();
            return t;
        };
        const qtyRaw = spanText('Rqtd');
        const unitRaw = spanText('RUN');
        const unitPriceRaw = spanText('RvlUnit');
        const totalRaw = spanText('valor');
        let qty = null;
        if (qtyRaw) {
            const n = Number.parseFloat(qtyRaw.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
            if (Number.isFinite(n))
                qty = n;
        }
        const unit = unitRaw ? (unitRaw.match(/[A-Za-zÇ]{1,6}/)?.[0] ?? null) : null;
        let totalCents = totalRaw ? parseMoneyToCents(totalRaw) : null;
        if (totalCents == null && qty != null && unitPriceRaw) {
            const u = parseMoneyToCents(unitPriceRaw);
            if (u != null)
                totalCents = Math.round(qty * u);
        }
        items.push({
            lineNumber: items.length + 1,
            description,
            eanExtracted: ean,
            storeProductCode: storeCode,
            qty,
            unitOriginal: unit ? unit.toUpperCase() : null,
            totalCents,
        });
    }
    return items;
}
/**
 * v30: ITENS do LAYOUT AXURE (página de consulta por QR da SEFAZ-SP).
 * A tabela <table id='grdItens'> tem UMA linha por item com DUAS células:
 *   1ª: "MAMAO PAPAYA kg<br>(Código: 8142)<br><b>Qtde.:</b> 2,616 <b>UN:</b> Kg
 *       <b>Vl. Unit.:</b> 5,89"
 *   2ª: "Vl. Total<br>15,40"
 * A linha de cabeçalho da tabela ("Descrição | Vl. Total") é descartada.
 * Código de 8/12–14 dígitos = EAN/GTIN; qualquer outro = código da loja.
 */
function parseNfceItemsAxure(html) {
    const tableMatch = html.match(/<table[^>]*id=["']grdItens["'][^>]*>([\s\S]*?)<\/table>/i);
    if (!tableMatch)
        return [];
    const rows = tableMatch[1].split(/<tr/i).slice(1);
    const items = [];
    const cellText = (frag) => decodeEntities(frag.replace(/<[^>]*>/g, ' '));
    for (const row of rows) {
        // cada fragmento pós-split começa em "<td ...>CONTEÚDO</td>..." — recorta o
        // conteúdo até o </td> correspondente
        const cells = row
            .split(/<td/i)
            .slice(1)
            .map((frag) => {
            const open = frag.indexOf('>');
            if (open < 0)
                return '';
            const rest = frag.slice(open + 1);
            const close = rest.search(/<\/td>/i);
            return close >= 0 ? rest.slice(0, close) : rest;
        });
        if (cells.length < 1)
            continue;
        const first = cellText(cells[0]);
        if (!first || first.length < 2)
            continue;
        // Descrição: texto antes de "(Código:"
        const descM = first.match(/^(.*?)\s*\(C[oó]digo\s*:/i);
        const description = (descM ? descM[1] : first.split(/\(C[oó]digo\s*:/i)[0]).trim();
        if (!description || description.length < 2)
            continue;
        // Linha de cabeçalho da tabela ("Descrição", "Produto", "Item") — não é item
        if (/^(Descri[çc][aã]o|Produto|Itens?)$/i.test(description))
            continue;
        // Código do produto (EAN/GTIN de 8/12–14 dígitos OU código interno da loja)
        let ean = null;
        let storeCode = null;
        const codM = first.match(/C[oó]digo\s*:\s*([A-Za-z0-9][A-Za-z0-9-]{0,24})/i);
        if (codM) {
            if (/^\d{8}$|^\d{12,14}$/.test(codM[1]))
                ean = codM[1];
            else
                storeCode = codM[1];
        }
        // Quantidade ("Qtde.: 2,616"), unidade ("UN: Kg") e valor unitário
        let qty = null;
        const qtyM = first.match(/Qtde\.?\s*:?\s*([\d.,]+)/i);
        if (qtyM) {
            const n = Number.parseFloat(qtyM[1].replace(/\./g, '').replace(',', '.'));
            if (Number.isFinite(n))
                qty = n;
        }
        const unit = first.match(/\bUN\s*:\s*([A-Za-z]{1,6})/i)?.[1]?.toUpperCase() ?? null;
        const unitPriceRaw = first.match(/Vl\.?\s*Unit\.?\s*:?\s*([\d.,]+)/i)?.[1] ?? null;
        // Valor total: 2ª célula ("Vl. Total 15,40"); fallback = qtde × vl. unit.
        let totalCents = null;
        if (cells.length > 1) {
            const second = cellText(cells[1]);
            const totalRaw = second.match(/Vl\.?\s*Total\s*:?\s*([\d.,]+)/i)?.[1] ??
                second.match(/([\d]+\.\d{3},\d{2}|[\d]+,\d{2})\s*$/)?.[1] ??
                null;
            if (totalRaw)
                totalCents = parseMoneyToCents(totalRaw);
        }
        if (totalCents == null && qty != null && unitPriceRaw) {
            const u = parseMoneyToCents(unitPriceRaw);
            if (u != null)
                totalCents = Math.round(qty * u);
        }
        // Linha precisa parecer item: código OU quantidade OU total
        if (!codM && qty == null && totalCents == null)
            continue;
        items.push({
            lineNumber: items.length + 1,
            description,
            eanExtracted: ean,
            storeProductCode: storeCode,
            qty,
            unitOriginal: unit,
            totalCents,
        });
    }
    return items;
}
/**
 * Extrai os itens da página (Passo 3 do ARQ-008 — roda em background).
 * v18: parser com MERGE de linhas — a página da SEFAZ-SP mostra cada item em
 * DUAS linhas de tabela (a visível com descrição/valores compactos e a de
 * detalhes com rótulos "Código do produto (GTIN/EAN)", "Qtde total de itens",
 * "Unidade comercial", "Valor total do item"). Os campos das duas linhas são
 * MESCLADOS no mesmo item; nunca há itens duplicados nem rótulos como descrição.
 */
function parseNfceItems(html) {
    // v30: layout Axure da página de consulta por QR (tabela grdItens) primeiro —
    // o leitor genérico não conhece esse layout e sujaria a extração.
    const axure = parseNfceItemsAxure(html);
    if (axure.length > 0)
        return axure;
    // v26: layout público atual (classes txtTit/Rqtd/RUN/valor) — leitura exata.
    const byClass = parseNfceItemsByClass(html);
    if (byClass.length > 0)
        return byClass;
    const rows = html.split(/<tr/i).slice(1);
    const items = [];
    let current = null;
    const flush = () => {
        if (current && current.description) {
            current.lineNumber = items.length + 1;
            items.push(current);
        }
        current = null;
    };
    for (const row of rows) {
        const texts = Array.from(row.matchAll(/>([^<>]+)</g))
            .map((m) => decodeEntities(m[1]))
            .filter((t) => t.length > 0);
        if (!texts.length)
            continue;
        const joined = texts.join(' § ');
        // v25: linha de CABEÇALHO da nota — pula inteira (nunca vira item; a linha
        // legada do cabeçalho carregava a LOJA e o VALOR TOTAL da nota).
        if (HEADER_ROW_RE.test(joined)) {
            flush();
            continue;
        }
        // ---- Classifica a linha ----
        // Linhas de DETALHES (layout novo): vêm DEPOIS da linha visível do item e
        // trazem só rótulos ("Código do produto (GTIN/EAN):", "Qtde total de itens:",
        // "Unidade comercial:", "Valor total do item:", "Descrição:").
        // Linhas de item ANTIGAS (layout compacto) também têm esses rótulos — mas
        // COMEÇAM com a descrição do produto, o que as diferencia.
        const hasDetailLabels = /C[oó]digo\s+do\s+produto|GTIN\/EAN|Qtde\.?\s*total\s*de\s*itens|Unidade\s+comercial|Valor\s+total\s+do\s+item|Descri[çc][aã]o\s*:/i.test(joined);
        const descOverride = joined.match(/Descri[çc][aã]o[^§]{0,12}§\s*([^§]{3,})/i);
        const startsWithDescription = (() => {
            for (const t of texts) {
                if (/^\d{1,3}$/.test(t))
                    continue; // numeração da linha
                const clean = t.replace(/:\s*$/, '').trim();
                if (LABEL_RE.test(clean))
                    return false; // rótulo antes da descrição
                if (MONEY_TOKEN_RE.test(t) || QTY_TOKEN_RE.test(t))
                    return false;
                if (t.length >= 3)
                    return true; // primeiro conteúdo é a descrição
            }
            return false;
        })();
        const isDetailsRow = hasDetailLabels && !(startsWithDescription && !descOverride);
        // ---- Descrição do item ----
        // Prioridade 1: o valor do rótulo "Descrição: X" da linha de detalhes.
        let description = descOverride ? descOverride[1].trim() : null;
        // Prioridade 2: primeiro texto que não é rótulo/valor monetário/quantidade/código
        if (!description) {
            for (const t of texts) {
                const clean = t.replace(/:\s*$/, '').trim();
                if (LABEL_RE.test(clean))
                    continue;
                if (HEADER_LABEL_RE.test(clean))
                    continue; // dados do cabeçalho da nota
                if (MONEY_TOKEN_RE.test(t))
                    continue;
                if (QTY_TOKEN_RE.test(t))
                    continue;
                if (/^item\s*\d+$/i.test(t))
                    continue;
                if (/^\d{1,3}$/.test(t))
                    continue; // numeração da linha na tabela
                if (/^\d{5,}$/.test(t))
                    continue; // códigos numéricos (GTIN/EAN, código da loja)
                if (t.length < 3)
                    continue;
                description = t;
                break;
            }
        }
        if (!description) {
            const descMatch = joined.match(/(?:Item\s*\d+|Descri[çc][aã]o)[^§]{0,12}§\s*([^§]{3,})/i);
            description = descMatch ? descMatch[1].trim() : null;
        }
        // Linha VISÍVEL de item (não é linha de detalhes) → começa um NOVO item
        if (!isDetailsRow) {
            flush();
            current = {
                lineNumber: 0,
                description,
                eanExtracted: null,
                storeProductCode: null,
                qty: null,
                unitOriginal: null,
                totalCents: null,
            };
        }
        else if (current) {
            // Detalhes enriquecem o item aberto — a descrição só é substituída pelo
            // rótulo "Descrição:" legítimo (nunca por um código ou rótulo solto)
            if (descOverride)
                current.description = descOverride[1].trim();
        }
        else {
            // Detalhes sem item visível antes (layout só com detalhes) — abre item
            current = {
                lineNumber: 0,
                description,
                eanExtracted: null,
                storeProductCode: null,
                qty: null,
                unitOriginal: null,
                totalCents: null,
            };
        }
        if (!current)
            continue;
        // ---- Código do produto (GTIN/EAN com 8/12–14 dígitos OU código da loja)
        // v25: 6–14 aceitava código de loja de 6/7 dígitos como se fosse EAN.
        const eanMatch = joined.match(/C[oó]digo\s*(?:\(\s*GTIN\/EAN\s*\))?[^§:]{0,40}:?\s*§?\s*(\d{8}|\d{12,14})\b/i) ??
            joined.match(/GTIN\/EAN[^§:]{0,40}:?\s*§?\s*(\d{8}|\d{12,14})\b/i);
        if (eanMatch) {
            current.eanExtracted = eanMatch[1];
        }
        else {
            const codeMatch = joined.match(/C[oó]digo\s+do\s+produto[^§:]{0,40}:?\s*§?\s*([A-Z0-9][A-Z0-9-]{1,19})/i);
            if (codeMatch) {
                // v25: EAN/GTIN tem 8, 12, 13 ou 14 dígitos — códigos numéricos de loja
                // com outra quantidade (5, 6, 7, 9–11) NÃO são EAN (antes um código de
                // loja de 6 dígitos virava "EAN" e sujava a resolução de produto).
                if (/^\d{8}$|^\d{12,14}$/.test(codeMatch[1]))
                    current.eanExtracted = codeMatch[1];
                else
                    current.storeProductCode = codeMatch[1];
            }
        }
        // ---- Quantidade e unidade (rótulos da linha de detalhes)
        const qtyLabel = joined.match(/Qtde\.?\s*total\s*de\s*itens[^§:]{0,40}:?\s*§?\s*([\d.,]+)\s*([A-Za-zÇÇ]{1,6})?/i) ??
            joined.match(/Quantidade\s*(?:comercial)?[^§:]{0,40}:?\s*§?\s*([\d.,]+)\s*([A-Za-zÇÇ]{1,6})?/i) ??
            joined.match(/Qtde\.?[^§:]{0,40}:?\s*§?\s*([\d.,]+)\s*([A-Za-zÇÇ]{1,6})?/i);
        if (qtyLabel) {
            const n = Number.parseFloat(qtyLabel[1].replace(/\./g, '').replace(',', '.'));
            if (Number.isFinite(n))
                current.qty = n;
            current.unitOriginal = qtyLabel[2] ?? current.unitOriginal;
        }
        const unitMatch = joined.match(/Unidade\s+(?:comercial\s*)?[^§:]{0,40}:?\s*§?\s*([A-Za-zÇÇ]{1,6})/i);
        if (unitMatch)
            current.unitOriginal = unitMatch[1];
        // ---- v25: CÉLULAS NUAS (layout de tabela com colunas separadas, sem
        // rótulos — portal público): depois da descrição, uma célula numérica
        // ("2,0000") seguida de uma célula de UNIDADE conhecida = quantidade/un.
        // O número da linha ("1", "2"...) fica ANTES da descrição — nunca pega.
        if (current.qty == null && !isDetailsRow && description) {
            const UNIT_SET = new Set([
                'G', 'GR', 'GRAMAS', 'KG', 'KGS', 'QUILO', 'QUILOS', 'ML', 'MILILITRO', 'MILILITROS',
                'L', 'LT', 'LITRO', 'LITROS', 'UN', 'UND', 'UNIDADE', 'UNIDADES', 'CX', 'PC',
            ]);
            const descIdx = texts.findIndex((t) => t === description);
            if (descIdx >= 0) {
                for (let j = descIdx + 1; j < texts.length - 1; j++) {
                    if (/^\d{1,6}(?:,\d{1,4})?$/.test(texts[j]) && UNIT_SET.has(texts[j + 1].toUpperCase())) {
                        const n = Number.parseFloat(texts[j].replace(',', '.'));
                        if (Number.isFinite(n)) {
                            current.qty = n;
                            current.unitOriginal = texts[j + 1].toUpperCase();
                        }
                        break;
                    }
                }
            }
        }
        // ---- Valor total do item (rótulo) OU formato compacto "2 UN × R$ 4,99" + "R$ 9,98"
        const totalLabel = joined.match(/Valor\s+total\s+do\s+item[^§:]{0,40}:?\s*§?\s*R\$\s*([\d.,]+)/i) ??
            joined.match(/Valor\s+total[^§:]{0,40}:?\s*§?\s*R\$\s*([\d.,]+)/i);
        if (totalLabel) {
            current.totalCents = parseMoneyToCents(totalLabel[1]);
        }
        else if (!isDetailsRow) {
            const compact = joined.match(/([\d.,]+)\s*([A-Za-z]{1,6})\s*[x×]\s*R\$\s*([\d.,]+)/i);
            if (compact) {
                const q = Number.parseFloat(compact[1].replace(/\./g, '').replace(',', '.'));
                const unitPriceCents = parseMoneyToCents(compact[3]);
                if (Number.isFinite(q) && unitPriceCents != null) {
                    current.qty = current.qty ?? q;
                    current.unitOriginal = current.unitOriginal ?? compact[2];
                    current.totalCents = current.totalCents ?? Math.round(q * unitPriceCents);
                }
            }
            if (current.totalCents == null && !/\bValor\s+(?:Pago|Total)\b|\bTroco\b|\bDesconto\b/i.test(joined)) {
                // \u00faltimo "R$ X" solto da linha vis\u00edvel = total do item (a linha de
                // totais da NOTA \u00e9 ignorada — "Valor Total/Pago" \u00e9 do cabe\u00e7alho)
                const moneys = Array.from(joined.matchAll(/R\$\s*([\d.,]+)/gi));
                if (moneys.length > 0)
                    current.totalCents = parseMoneyToCents(moneys[moneys.length - 1][1]);
            }
        }
        // Heurística de linha inválida (cabeçalho da tabela, totais da nota etc.)
        if (current.description) {
            if (/^Valor total/i.test(current.description) || /^Informações? (?:da )?Nota/i.test(current.description)) {
                current.description = null;
            }
        }
    }
    flush();
    return items;
}
