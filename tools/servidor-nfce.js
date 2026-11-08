'use strict';
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const VERSAO = '1.1-fix';
const PORTA = Number(process.env.PORTA_NFCE || 3000);
const HOSTS_PERMITIDOS = ['fazenda.sp.gov.br'];
const TIMEOUT_FETCH_MS = 20000;
const TIMEOUT_NAVEGADOR_MS = 45000;
const PORTAO_GAP_MS = 2000;
const PORTAO_BACKOFF_MS = [60000, 180000, 600000];
const UA_CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HEADERS_CHROME = {
  'User-Agent': UA_CHROME_WINDOWS,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};
function agora(){return new Date().toTimeString().slice(0,8)}
function log(...args){console.log(`[${agora()}]`,...args)}
function fmtBytes(n){return n>=1024?`${(n/1024).toFixed(1)} KB`:`${n} B`}
function dormir(ms){return new Promise(r=>setTimeout(r,ms))}
let ultimoHit=0;let falhasSeguidas=0;let fechadoAte=0;
function gateRestante(){return Math.max(0,Math.ceil((fechadoAte-Date.now())/1000))}
function marcarHit(){ultimoHit=Date.now()}
function marcarFalhaTotal(){falhasSeguidas=Math.min(falhasSeguidas+1,PORTAO_BACKOFF_MS.length);fechadoAte=Date.now()+PORTAO_BACKOFF_MS[falhasSeguidas-1];return PORTAO_BACKOFF_MS[falhasSeguidas-1]}
function marcarSucesso(){falhasSeguidas=0;fechadoAte=0;marcarHit()}
function tituloDe(html){const m=html.match(/<title[^>]*>([^<]{0,200})<\/title>/i);return m?m[1].trim():''}
function supportIdDe(html){const m=html.match(/support\s*ID\s*(?:is:)?\s*([\d.\-]+)/i);return m?m[1]:null}
function ehRejeicao(html){if(/Valor\s+(?:Total|a\s+Pagar)|Nome\s+Empresarial/i.test(html))return false;return /requested\s+URL\s+was\s+rejected|Your\s+support\s+ID|Request\s+Rejected|Access\s+Denied/i.test(html)}
function ehNota(html){if(html.length<3000)return false;if(/Consulta\s+Resumida|Consulta\s+Completa/i.test(html)&&html.length>8000)return true;return /NFC-?e|Nome\s+Empresarial|Valor\s+(?:Total|a\s+Pagar)|grdItens|tabResult|Emitente/i.test(html)}
function ehDesafio(html){if(ehNota(html))return false;return /TSPD|APM_DO_NOT_TOUCH/i.test(html)&&!ehRejeicao(html)}
function hostPermitido(url){try{const h=new URL(url).hostname.toLowerCase();return HOSTS_PERMITIDOS.some(p=>h===p||h.endsWith('.'+p))}catch{return false}}
async function buscarViaFetch(url){const t0=Date.now();const r=await fetch(url,{headers:HEADERS_CHROME,redirect:'follow',signal:AbortSignal.timeout(TIMEOUT_FETCH_MS)});const html=await r.text();return{html,status:r.status,ms:Date.now()-t0}}
function acharNavegador(){if(process.platform==='win32'){const pf=process.env['ProgramFiles']||'C:\\Program Files';const pf86=process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)';const lad=process.env['LOCALAPPDATA']||'';const cand=[`${pf}\\Google\\Chrome\\Application\\chrome.exe`,`${pf86}\\Google\\Chrome\\Application\\chrome.exe`,lad?`${lad}\\Google\\Chrome\\Application\\chrome.exe`:'',`${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,lad?`${lad}\\Microsoft\\Edge\\Application\\msedge.exe`:''].filter(Boolean);return cand.find(p=>{try{return fs.existsSync(p)}catch{return false}})||null}if(process.platform==='darwin'){const cand=['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];return cand.find(p=>{try{return fs.existsSync(p)}catch{return false}})||null}for(const nome of['google-chrome','google-chrome-stable','chromium','chromium-browser','microsoft-edge']){const r=spawnSync('which',[nome],{encoding:'utf8'});if(r.status===0&&r.stdout&&r.stdout.trim())return r.stdout.trim()}return null}
function buscarViaNavegador(url,exe){
  const t0=Date.now();
  const perfil=path.join(os.tmpdir(),'nfce-headless-perfil');
  const args=[
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--disable-extensions',
    '--disable-blink-features=AutomationControlled',
    `--user-data-dir=${perfil}`,
    `--user-agent=${UA_CHROME_WINDOWS}`,
    '--virtual-time-budget=25000',
    '--run-all-compositor-stages-before-draw',
    '--dump-dom',
    url,
  ];
  let r=spawnSync(exe,args,{timeout:TIMEOUT_NAVEGADOR_MS,maxBuffer:64*1024*1024,encoding:'buffer',windowsHide:true});
  let html=r.stdout?r.stdout.toString('utf8'):'';
  if((r.error||r.status!==0)&&html.length<200){
    const args2=['--headless',...args.slice(1)];
    r=spawnSync(exe,args2,{timeout:TIMEOUT_NAVEGADOR_MS,maxBuffer:64*1024*1024,encoding:'buffer',windowsHide:true});
    html=r.stdout?r.stdout.toString('utf8'):'';
  }
  const erro=r.error?String(r.error.message||r.error):null;
  return{html,ms:Date.now()-t0,erro}
}
let consultando=false;
async function consultar(url){
  if(!url||typeof url!=='string'){return{status:400,body:{ok:false,erro:'url_faltando'}}}
  if(!hostPermitido(url)){return{status:400,body:{ok:false,erro:'url_invalida'}}}
  const g=gateRestante();if(g>0){return{status:429,body:{ok:false,gate:g,motivo:'cooldown',mensagem:`Portão anti-ban fechado no PC — espere ${g}s`}}}
  if(consultando){return{status:429,body:{ok:false,gate:1,motivo:'ocupado'}}}
  const desde=Date.now()-ultimoHit;if(ultimoHit>0&&desde<PORTAO_GAP_MS)await dormir(PORTAO_GAP_MS-desde);
  consultando=true;try{return await executarConsulta(url)}finally{consultando=false}
}
async function executarConsulta(url){
  marcarHit();
  log(`consultar ← app: ${url.slice(0,110)}…`);
  let ultimoHtml='';let ultimoTipo='desconhecida';
  try{
    const r1=await buscarViaFetch(url);
    ultimoHtml=r1.html;
    if(ehRejeicao(r1.html))ultimoTipo='rejeicao';
    else if(ehDesafio(r1.html))ultimoTipo='desafio';
    else if(ehNota(r1.html)){
      marcarSucesso();
      log(`consultar → NOTA via fetch · ${fmtBytes(r1.html.length)} · ${tituloDe(r1.html)||'(sem título)'} · ${(r1.ms/1000).toFixed(1)}s`);
      return{status:200,body:{ok:true,html:r1.html,bytes:r1.html.length,titulo:tituloDe(r1.html),estrategia:'fetch',elapsedMs:r1.ms}}
    }
    log(`consultar → fetch trouxe ${ultimoTipo.toUpperCase()} (${fmtBytes(r1.html.length)}${supportIdDe(r1.html)?` · support ${supportIdDe(r1.html)}`:''})`);
  }catch(e){log(`consultar → fetch falhou: ${String((e&&e.message)||e)}`)}
  const exe=acharNavegador();
  if(exe){
    const nome=path.basename(exe);
    log(`consultar → tentando pelo navegador REAL do PC (${nome}, headless)`);
    try{
      const r2=buscarViaNavegador(url,exe);
      if(r2.html&&!ehRejeicao(r2.html)&&ehNota(r2.html)){
        marcarSucesso();
        log(`consultar → NOTA via ${nome} · ${fmtBytes(r2.html.length)} · ${tituloDe(r2.html)||'(sem título)'} · ${(r2.ms/1000).toFixed(1)}s`);
        return{status:200,body:{ok:true,html:r2.html,bytes:r2.html.length,titulo:tituloDe(r2.html),estrategia:'navegador',elapsedMs:r2.ms}}
      }
      if(r2.html){ultimoHtml=r2.html;ultimoTipo=ehRejeicao(r2.html)?'rejeicao':ehDesafio(r2.html)?'desafio':ultimoTipo}
      log(`consultar → ${nome} não trouxe a nota (${r2.erro||(r2.html?`página ${fmtBytes(r2.html.length)} · ${tituloDe(r2.html)||'sem título'}`:'sem saída')})`);
    }catch(e){log(`consultar → navegador falhou: ${String((e&&e.message)||e)}`)}
  }else{log('consultar → navegador real não encontrado')}
  const espera=marcarFalhaTotal();
  const seg=Math.round(espera/1000);
  log(`consultar → FALHA TOTAL (${ultimoTipo}) — portão do PC FECHADO por ${seg}s (falhas seguidas: ${falhasSeguidas})`);
  if(ultimoTipo==='desafio'){return{status:403,body:{ok:false,desafio:true,html:ultimoHtml,mensagem:`Desafio — portão fechado por ${seg}s`,estrategia:'fetch+navegador'}}}
  return{status:403,body:{ok:false,bloqueado:true,html:ultimoHtml,supportId:supportIdDe(ultimoHtml),gate:seg,mensagem:`Firewall recusou — portão fechado por ${seg}s`,estrategia:'fetch+navegador'}}
}
function json(res,status,body){const buf=Buffer.from(JSON.stringify(body),'utf8');res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':buf.length,'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'});res.end(buf)}
function lerCorpo(req,limite=64*1024){return new Promise((resolve,reject)=>{let data='';req.on('data',c=>{data+=c;if(data.length>limite){reject(new Error('corpo grande demais'));req.destroy()}});req.on('end',()=>resolve(data));req.on('error',reject)})}
const server=http.createServer((req,res)=>{
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'});res.end();return}
  let u;try{u=new URL(req.url,'http://local')}catch{json(res,400,{ok:false});return}
  if(u.pathname==='/health'){json(res,200,{ok:true,servidor:'nfce-pc',versao:VERSAO,gate:gateRestante(),navegador:acharNavegador()?'disponivel':'ausente'});return}
  if(u.pathname==='/consultar'){
    const pegaUrl=async()=>{if(req.method==='POST'){const corpo=await lerCorpo(req);try{return(JSON.parse(corpo)||{}).url}catch{return null}}return u.searchParams.get('url')};
    pegaUrl().then(url=>consultar(url)).then(({status,body})=>json(res,status,body)).catch(e=>json(res,500,{ok:false,erro:'interno'}));
    return
  }
  json(res,404,{ok:false,erro:'rota_desconhecida'})
});
process.on('unhandledRejection',e=>log('erro interno:',String((e&&e.message)||e)));
server.listen(PORTA,'0.0.0.0',()=>{
  const okNode=typeof fetch==='function';
  const exe=acharNavegador();
  const ips=[];
  for(const nome of Object.keys(os.networkInterfaces())){for(const i of os.networkInterfaces()[nome]||[]){if(i.family==='IPv4'&&!i.internal)ips.push(i.address)}}
  console.log('──────────────────────────────────────────────────────────');
  console.log(`  SERVIDOR NFC-e para o MyFinance · v${VERSAO}`);
  console.log(`  Node ${process.version} · fetch nativo: ${okNode?'OK':'AUSENTE'}`);
  console.log(`  Navegador real p/ plano B: ${exe?path.basename(exe):'não encontrado'}`);
  console.log('  Deixe este terminal ABERTO. Ctrl+C para parar.');
  if(ips.length){console.log('  Endereços deste PC:');for(const ip of ips)console.log(`    · http://${ip}:${PORTA}`)}
  console.log(`  Teste: http://localhost:${PORTA}/health`);
  console.log('──────────────────────────────────────────────────────────')
});