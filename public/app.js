'use strict';
/* Revisão Premium | Registro e acompanhamento. Interface sem dependências externas. */
const S = { me: null, cfg: null, es: null, live: false, fila: { itens: [], agora: '' }, aguardando: 0, f: { preset: 'hoje', de: '', ate: '', loja: '', colab: '' }, c: { q: '', filtro: '', loja: '' }, adminTab: 'usuarios' };
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PERFIL = { colaborador: 'Colaborador', gestor_loja: 'Gestor de loja', gestor_kinto: 'Gestor KINTO', kinto: 'Consultor KINTO' };
const BADGE = { 'Aceitou': 'ok', 'Recusou': 'bad', 'Ainda não decidiu': 'warn', 'Concluída': 'ok', 'Não concluída': 'bad', 'Aguardando': 'warn', 'Em atendimento': 'info' };

const hojeBR = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const addDias = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const fmtData = (d) => (d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '');
const fmtHora = (s) => (s ? fmtData(s.slice(0, 10)) + ' ' + s.slice(11, 16) : '');
const fmtTel = (t) => { t = String(t || ''); return t.length === 11 ? `(${t.slice(0, 2)}) ${t.slice(2, 7)}-${t.slice(7)}` : t.length === 10 ? `(${t.slice(0, 2)}) ${t.slice(2, 6)}-${t.slice(6)}` : t; };
const brl = (n) => (n == null ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const pct = (n) => (n == null ? '—' : (n * 100).toFixed(1).replace('.0', '').replace('.', ',') + '%');
const badge = (t) => `<span class="badge ${BADGE[t] || ''}">${esc(t)}</span>`;
const opts = (list, sel, ph) => (ph != null ? `<option value="">${esc(ph)}</option>` : '') +
  list.map((o) => { const v = typeof o === 'object' ? o.id : o, l = typeof o === 'object' ? o.nome : o; return `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(l)}</option>`; }).join('');

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let d = {};
  try { d = await r.json(); } catch { /* corpo vazio */ }
  if (r.status === 401 && path !== '/login') { S.me = null; stopLive(); renderLogin(); throw new Error('Sessão expirada. Entre novamente.'); }
  if (!r.ok) throw new Error(d.erro || 'Erro inesperado');
  return d;
}
function toast(msg, tipo = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + tipo; t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3500);
}
function modal(titulo, html, { wide = false } = {}) {
  const back = document.createElement('div');
  back.className = 'back';
  back.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true"><div class="modal-head"><h2>${esc(titulo)}</h2><button class="x" aria-label="Fechar">×</button></div><div class="mbody">${html}</div></div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  $('.x', back).addEventListener('click', close);
  document.body.append(back);
  return { el: $('.mbody', back), close, root: back };
}
function applyBars(root) {
  $$('[data-w]', root).forEach((e) => { e.style.width = e.dataset.w + '%'; });
  $$('[data-h]', root).forEach((e) => { e.style.height = e.dataset.h + '%'; });
}
// Baixa um arquivo da API sem sair da página; mostra o motivo se algo falhar (ex.: sessão expirada).
async function baixarArquivo(url, botao) {
  const rotulo = botao ? botao.textContent : '';
  if (botao) { botao.disabled = true; botao.textContent = 'Gerando…'; }
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (r.status === 401) { S.me = null; stopLive(); renderLogin(); throw new Error('Sessão expirada. Entre novamente.'); }
    if (!r.ok) { let d = {}; try { d = await r.json(); } catch { /* sem corpo */ } throw new Error(d.erro || 'Não foi possível gerar o arquivo (erro ' + r.status + ')'); }
    const cd = r.headers.get('Content-Disposition') || '';
    const nome = (/filename="?([^";]+)"?/.exec(cd) || [])[1] || 'exportacao.csv';
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = nome; document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Arquivo gerado: ' + nome, 'ok');
  } catch (e) { toast(e.message || 'Falha ao exportar', 'err'); }
  finally { if (botao) { botao.disabled = false; botao.textContent = rotulo; } }
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------------- login ---------------- */
function renderLogin() {
  $('#app').innerHTML = `<div class="login"><div class="card">
    <div class="logos"><img class="logo-saga" src="/img/logo-saga-toyota.png" alt="Toyota Saga" width="700" height="193"><span class="sep" aria-hidden="true"></span><img class="logo-kinto" src="/img/logo-kinto.png" alt="KINTO" width="700" height="127"></div>
    <h1>Revisão Premium</h1><p class="muted sub">Saga Toyota × KINTO Share · Registro de contatos</p>
    <form id="lf"><div class="field"><label for="le">E-mail</label><input id="le" type="email" autocomplete="username" required></div>
    <div class="field"><label for="ls">Senha</label><input id="ls" type="password" autocomplete="current-password" required></div>
    <div class="err" id="lerr"></div><button class="btn big">Entrar</button></form></div></div>`;
  $('#le').focus();
  $('#lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = $('button', e.target); b.disabled = true; $('#lerr').textContent = '';
    try {
      S.me = await api('/login', { method: 'POST', body: { email: $('#le').value, senha: $('#ls').value } });
      await iniciar();
    } catch (err) { $('#lerr').textContent = err.message; b.disabled = false; }
  });
}

/* ---------------- estrutura ---------------- */
async function iniciar() {
  S.cfg = await api('/config');
  const g = S.me.perfil === 'gestor_loja' || S.me.perfil === 'gestor_kinto';
  const k = S.me.perfil === 'kinto';
  $('#app').innerHTML = `<header class="top"><div class="top-in">
    <div class="brand"><span class="logo-pill"><img class="logo-saga" src="/img/logo-saga-toyota.png" alt="Toyota Saga" width="700" height="193"><span class="sep" aria-hidden="true"></span><img class="logo-kinto" src="/img/logo-kinto.png" alt="KINTO" width="700" height="127"></span><span class="brand-t">Revisão Premium</span></div>
    <nav class="nav" id="nav">
      ${k ? '' : '<a href="#/registrar" data-r="registrar">Registrar</a>'}
      ${g || k ? '<a href="#/fila" data-r="fila">Atendimento KINTO <span class="cnt hidden" id="cnt">0</span></a>' : ''}
      ${g ? '<a href="#/painel" data-r="painel">Painel</a><a href="#/casos" data-r="casos">Casos</a>' : ''}
      ${S.me.perfil === 'gestor_kinto' ? '<a href="#/admin" data-r="admin">Administração</a>' : ''}
    </nav>
    <div class="user"><div class="who">${esc(S.me.nome)}<small>${esc(PERFIL[S.me.perfil])}${S.me.loja_nome ? ' · ' + esc(S.me.loja_nome) : ''}</small></div>
      <button class="linkbtn" id="pw">Senha</button><button class="linkbtn" id="out">Sair</button></div></div></header><main id="view"></main>`;
  $('#out').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); S.me = null; stopLive(); location.hash = ''; renderLogin(); });
  $('#pw').addEventListener('click', trocarSenha);
  if (g || k) { startLive(); pedePermissao(); atualizaContagem(); }
  window.onhashchange = route;
  route();
}
function route() {
  if (!S.me) return;
  const p = S.me.perfil, g = p === 'gestor_loja' || p === 'gestor_kinto';
  const padrao = p === 'colaborador' ? 'registrar' : p === 'kinto' ? 'fila' : 'painel';
  let r = (location.hash.replace('#/', '') || '').split('?')[0];
  const permitidas = p === 'colaborador' ? ['registrar'] : p === 'kinto' ? ['fila'] : g ? ['registrar', 'fila', 'painel', 'casos'].concat(p === 'gestor_kinto' ? ['admin'] : []) : [];
  if (!permitidas.includes(r)) r = padrao;
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.r === r));
  S.rota = r;
  ({ registrar: viewRegistrar, fila: viewFila, painel: viewPainel, casos: viewCasos, admin: viewAdmin })[r]();
}
function trocarSenha() {
  const m = modal('Trocar senha', `<form id="pf"><div class="field"><label>Senha atual</label><input type="password" name="atual" autocomplete="current-password" required></div>
    <div class="field"><label>Nova senha (mínimo 8 caracteres)</label><input type="password" name="nova" autocomplete="new-password" minlength="8" required></div>
    <div class="err" id="perr"></div><button class="btn">Salvar</button></form>`);
  $('#pf', m.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/senha', { method: 'POST', body: { atual: e.target.atual.value, nova: e.target.nova.value } }); m.close(); toast('Senha alterada', 'ok'); }
    catch (err) { $('#perr', m.el).textContent = err.message; }
  });
}

/* ---------------- tempo real ---------------- */
function startLive() {
  stopLive();
  const es = new EventSource('/api/stream');
  S.es = es;
  es.onopen = () => { S.live = true; marcaLive(); };
  es.onerror = () => { S.live = false; marcaLive(); };
  es.addEventListener('update', debounce(() => { atualizaContagem(); if (S.rota === 'painel') carregaPainel(); if (S.rota === 'casos') carregaCasos(); if (S.rota === 'fila') carregaFila(); }, 400));
  // Só o time KINTO da loja do cliente recebe este evento (o servidor filtra pela loja do usuário).
  es.addEventListener('aceite', (ev) => {
    let d = {}; try { d = JSON.parse(ev.data); } catch { /* ignora */ }
    if (S.me.perfil !== 'kinto') return;
    avisoNovoCliente(d);
  });
}
function pedePermissao() { try { if (S.me.perfil === 'kinto' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* sem suporte */ } }
let audioCtx = null;
function bip() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    [880, 1175].forEach((f, i) => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + i * 0.18; g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16); o.start(t0); o.stop(t0 + 0.17); });
  } catch { /* navegador bloqueou o som */ }
}
const TITULO = document.title;
let piscaTimer = null;
function avisoNovoCliente(d) {
  bip();
  const indeciso = d.origem === 'Ainda não decidiu';
  toast(`${indeciso ? 'Cliente indeciso para contato' : 'Novo cliente para atender'}${d.nome ? ': ' + d.nome : ''}`, 'ok');
  atualizaContagem();
  if (S.rota === 'fila') carregaFila();
  if (document.hidden) {
    let n = 0; clearInterval(piscaTimer);
    piscaTimer = setInterval(() => { document.title = n++ % 2 ? TITULO : '🔔 Cliente aguardando'; if (!document.hidden) { clearInterval(piscaTimer); document.title = TITULO; } }, 900);
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification('KINTO Share: cliente aguardando', { body: `${d.nome || 'Novo cliente'} ${indeciso ? 'ficou indeciso e precisa do seu contato.' : 'aceitou a oferta de locação.'}` }); } catch { /* ignora */ }
  }
}
async function atualizaContagem() {
  try {
    const f = await api('/fila');
    S.fila = f; S.aguardando = f.itens.filter((x) => x.situacao === 'Aguardando').length;
    const c = $('#cnt'); if (c) { c.textContent = S.aguardando; c.classList.toggle('hidden', !S.aguardando); }
  } catch { /* sessão expirada tratada em api() */ }
}
function stopLive() { if (S.es) S.es.close(); S.es = null; S.live = false; }
function marcaLive(hora) {
  const d = $('#livedot'); if (d) d.classList.toggle('on', S.live);
  const t = $('#livetxt'); if (t) t.textContent = (S.live ? 'Ao vivo' : 'Reconectando…') + (hora ? ' · atualizado às ' + hora : '');
}

/* ---------------- registrar contato ---------------- */
function viewRegistrar() {
  $('#view').innerHTML = `<div class="reg"><div class="page-head"><div><h1>Registrar contato</h1><div class="muted small">Informe a loja onde o cliente fará a revisão</div></div>
    <div class="dia" id="dia" aria-live="polite"><b id="dian">–</b><span>agendamentos<br>registrados hoje</span></div></div>
  <form class="card" id="f" novalidate>
    <div class="row"><div class="field"><label for="etapa">Etapa do contato</label><select id="etapa" name="etapa">${opts(S.cfg.etapas)}</select></div>
    <div class="field"><label for="dr">Data da revisão</label><input id="dr" type="date" name="data_revisao" value="${hojeBR()}"></div></div>
    <div class="field"><label for="lj">Loja da revisão</label><select id="lj" name="loja_id">${opts(S.cfg.lojas, '', 'Selecione')}</select></div>
    <div class="field"><label for="nome">Nome do cliente</label><input id="nome" name="cliente_nome" autocomplete="off" maxlength="120"></div>
    <div class="field"><label for="tel">Telefone</label><input id="tel" name="telefone" inputmode="tel" autocomplete="off" placeholder="(62) 99999-9999"></div>
    <div class="field"><label for="res">Resultado</label><select id="res" name="resultado">${opts(S.cfg.resultados, '', 'Selecione')}</select></div>
    <div class="field"><label for="mot">Motivo</label><select id="mot" name="motivo_id" disabled><option value="">Escolha o resultado primeiro</option></select></div>
    <div class="field"><label for="obs">Observação <span class="opt" id="obsopt">(opcional)</span></label><textarea id="obs" name="observacao" maxlength="500"></textarea></div>
    <div class="err" id="ferr"></div><button class="btn big" id="send">Enviar registro</button></form></div>`;
  const f = $('#f');
  const atualizaDia = async () => { try { const r = await api('/meu-dia'); const e = $('#dian'); if (e) e.textContent = r.agendamentos; } catch { /* contador é só informativo */ } };
  atualizaDia();
  $('#tel').addEventListener('input', (e) => {
    const d = e.target.value.replace(/\D/g, '').slice(0, 11);
    e.target.value = d.length > 6 ? `(${d.slice(0, 2)}) ${d.slice(2, d.length > 10 ? 7 : 6)}-${d.slice(d.length > 10 ? 7 : 6)}` : d.length > 2 ? `(${d.slice(0, 2)}) ${d.slice(2)}` : d;
  });
  $('#res').addEventListener('change', (e) => {
    const m = $('#mot'), lista = S.cfg.motivos.filter((x) => x.resultado === e.target.value);
    m.disabled = !lista.length;
    m.innerHTML = `<option value="">${lista.length ? 'Selecione o motivo' : 'Escolha o resultado primeiro'}</option>` + lista.map((x) => `<option value="${x.id}" data-obs="${x.exige_obs}">${esc(x.descricao)}</option>`).join('');
    $('#obsopt').textContent = '(opcional)';
  });
  $('#mot').addEventListener('change', (e) => { const o = e.target.selectedOptions[0]; $('#obsopt').textContent = o && o.dataset.obs === '1' ? '(obrigatória para "Outro")' : '(opcional)'; });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#ferr'); err.textContent = '';
    const v = Object.fromEntries(new FormData(f));
    if (!v.loja_id) return void (err.textContent = 'Escolha a loja da revisão (Anápolis ou Goiânia).');
    if (v.cliente_nome.trim().length < 2) return void (err.textContent = 'Informe o nome do cliente.');
    if (v.telefone.replace(/\D/g, '').length < 10) return void (err.textContent = 'Informe o telefone com DDD.');
    if (!v.resultado) return void (err.textContent = 'Escolha o resultado.');
    if (!v.motivo_id) return void (err.textContent = 'Escolha o motivo.');
    const b = $('#send'); b.disabled = true;
    try {
      await api('/contatos', { method: 'POST', body: v });
      toast(v.resultado === 'Aceitou' || v.resultado === 'Ainda não decidiu' ? 'Registro enviado ✓ O time KINTO da loja foi avisado' : 'Registro enviado ✓', 'ok');
      ['cliente_nome', 'telefone', 'observacao'].forEach((n) => { f[n].value = ''; });
      f.resultado.value = ''; f.resultado.dispatchEvent(new Event('change'));
      f.loja_id.value = ''; // obriga a escolher a loja a cada cliente: ela define quem na KINTO vai atender
      f.cliente_nome.focus();
      atualizaDia();
    } catch (ex) { err.textContent = ex.message; } finally { b.disabled = false; }
  });
}

/* ---------------- painel ---------------- */
function aplicaPreset(p) {
  const h = hojeBR();
  S.f.preset = p;
  if (p === 'hoje') { S.f.de = h; S.f.ate = h; }
  if (p === '7d') { S.f.de = addDias(h, -6); S.f.ate = h; }
  if (p === '30d') { S.f.de = addDias(h, -29); S.f.ate = h; }
  if (p === 'mes') { S.f.de = h.slice(0, 8) + '01'; S.f.ate = h; }
}
function viewPainel() {
  if (!S.f.de) aplicaPreset('hoje');
  const chip = (k, l) => `<button class="chip${S.f.preset === k ? ' on' : ''}" data-p="${k}">${l}</button>`;
  $('#view').innerHTML = `<div class="page-head"><div><h1>Painel</h1><div class="live"><span class="dot" id="livedot"></span><span id="livetxt">Conectando…</span></div></div>
    <div class="actions noprint"><button class="btn alt sm" id="ex3">Relatório do painel (CSV)</button><button class="btn alt sm" id="ex1">Contatos (CSV)</button><button class="btn alt sm" id="ex2">Reservas (CSV)</button><button class="btn sm" id="ex4">Gráficos e relatório (PDF)</button></div></div>
    <div class="printonly" id="pinfo"></div>
    <div class="printlogos"><img class="logo-saga" src="/img/logo-saga-toyota.png" alt="Toyota Saga"><span class="sep" aria-hidden="true"></span><img class="logo-kinto" src="/img/logo-kinto.png" alt="KINTO"></div>
    <div class="filters card" id="flt">
      <div class="chips">${chip('hoje', 'Hoje')}${chip('7d', '7 dias')}${chip('30d', '30 dias')}${chip('mes', 'Mês atual')}</div>
      <div class="f"><label>De</label><input type="date" id="fde" value="${S.f.de}"></div><div class="f"><label>Até</label><input type="date" id="fate" value="${S.f.ate}"></div>
      <div class="f"><label>Loja</label><select id="floja">${opts(S.cfg.lojas, S.f.loja, 'Todas')}</select></div>
      <div class="f"><label>Colaborador</label><select id="fcol">${opts(S.cfg.colaboradores, S.f.colab, 'Todos')}</select></div></div>
    <div id="pbody"><div class="empty">Carregando…</div></div>`;
  $$('.chip', $('#flt')).forEach((b) => b.addEventListener('click', () => { aplicaPreset(b.dataset.p); viewPainel(); }));
  const muda = () => { S.f.preset = ''; S.f.de = $('#fde').value; S.f.ate = $('#fate').value; S.f.loja = $('#floja').value; S.f.colab = $('#fcol').value; $$('.chip', $('#flt')).forEach((c) => c.classList.remove('on')); carregaPainel(); };
  ['fde', 'fate', 'floja', 'fcol'].forEach((id) => $('#' + id).addEventListener('change', muda));
  const per = () => `de=${S.f.de}&ate=${S.f.ate}`;
  const filtros = () => `${per()}&loja=${S.f.loja}&colab=${S.f.colab}`;
  $('#ex1').addEventListener('click', (e) => baixarArquivo('/api/export/contatos.csv?' + per(), e.currentTarget));
  $('#ex2').addEventListener('click', (e) => baixarArquivo('/api/export/reservas.csv?' + per(), e.currentTarget));
  $('#ex3').addEventListener('click', (e) => baixarArquivo('/api/export/painel.csv?' + filtros(), e.currentTarget));
  // PDF: abre a impressão do navegador com a página preparada para papel; basta escolher "Salvar como PDF".
  $('#ex4').addEventListener('click', () => {
    const lj = S.f.loja ? ($('#floja').selectedOptions[0] || {}).textContent : 'Todas as lojas';
    const cb = S.f.colab ? ($('#fcol').selectedOptions[0] || {}).textContent : 'Todos os colaboradores';
    $('#pinfo').textContent = `Revisão Premium · Período ${fmtData(S.f.de)} a ${fmtData(S.f.ate)} · ${lj} · ${cb}`;
    window.print();
  });
  marcaLive();
  carregaPainel();
}
const barras = (lista, cls) => {
  if (!lista.length) return '<div class="empty small">Sem registros no período</div>';
  const max = Math.max(...lista.map((x) => x.n)), tot = lista.reduce((s, x) => s + x.n, 0);
  return `<div class="bars">${lista.map((x) => `<div class="bar-row"><div class="name">${esc(x.motivo)}</div><div class="track"><div class="bar ${cls}" data-w="${(x.n / max) * 100}"></div></div><div class="n">${x.n} · ${Math.round((x.n / tot) * 100)}%</div></div>`).join('')}</div>`;
};
async function carregaPainel() {
  const box = $('#pbody'); if (!box) return;
  let p;
  try { p = await api(`/painel?de=${S.f.de}&ate=${S.f.ate}&loja=${S.f.loja}&colab=${S.f.colab}`); }
  catch (e) { if (S.me) box.innerHTML = `<div class="alert">${esc(e.message)}</div>`; return; }
  const t = p.totais, r = p.taxas;
  const kpi = (l, v, s) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s || '&nbsp;'}</div></div>`;
  const etapas = [['Agendamentos', t.agendamentos, ''], ['Contatados', t.contatados, ''], ['Ofertados', t.ofertados, ''], ['Aceitaram', t.aceitaram, 'ok'], ['Reserva concluída', t.concluidas, 'ok']];
  const base = t.agendamentos || 1;
  // série diária (agrupa por semana quando passa de 31 dias)
  let serie = p.serie;
  if (serie.length > 31) {
    const g = []; for (let i = 0; i < serie.length; i += 7) { const sl = serie.slice(i, i + 7); g.push({ data: sl[0].data, agendamentos: sl.reduce((s, x) => s + x.agendamentos, 0), aceitaram: sl.reduce((s, x) => s + x.aceitaram, 0), concluidas: sl.reduce((s, x) => s + x.concluidas, 0) }); }
    serie = g;
  }
  const mx = Math.max(1, ...serie.flatMap((x) => [x.agendamentos, x.aceitaram, x.concluidas]));
  box.innerHTML = `
    ${t.aceitos_sem_reserva ? `<div class="alert"><b>${t.aceitos_sem_reserva}</b> ${t.aceitos_sem_reserva === 1 ? 'cliente aceitou' : 'clientes aceitaram'} e ainda não ${t.aceitos_sem_reserva === 1 ? 'tem' : 'têm'} reserva registrada. <a href="#/casos" id="goac">Ver casos</a></div>` : ''}
    <div class="kpis">${kpi('Agendamentos', t.agendamentos)}${kpi('Ofertados', t.ofertados, pct(r.oferta) + ' dos agendamentos')}${kpi('Aceitaram', t.aceitaram, pct(r.aceite) + ' dos ofertados')}
      ${kpi('Reservas concluídas', t.concluidas, pct(r.conversao_total) + ' dos agendamentos')}${kpi('Diárias', t.diarias)}${kpi('Receita', brl(t.receita))}</div>
    <div class="grid g2">
      <div class="card funnel"><h2>Funil</h2><div class="bars">${etapas.map(([n, v, c]) => `<div class="bar-row"><div class="name">${n}</div><div class="track"><div class="bar ${c}" data-w="${(v / base) * 100}"></div></div><div class="n">${v} · ${Math.round((v / base) * 100)}%</div></div>`).join('')}</div>
        <div class="rates"><div class="rate"><b>${pct(r.oferta)}</b><span>Taxa de oferta</span></div><div class="rate"><b>${pct(r.aceite)}</b><span>Taxa de aceite</span></div>
        <div class="rate"><b>${pct(r.recuperacao)}</b><span>Recuperação na confirmação</span></div><div class="rate"><b>${pct(r.aceite_reserva)}</b><span>Aceite → reserva</span></div>
        <div class="rate"><b>${pct(r.conversao_total)}</b><span>Conversão total</span></div></div></div>
      <div class="card"><h2>${p.serie.length > 31 ? 'Por semana' : 'Por dia'}</h2>
        <div class="chart">${serie.map((x) => `<div class="col" title="${fmtData(x.data)}: ${x.agendamentos} agend., ${x.aceitaram} aceites, ${x.concluidas} reservas"><div class="stack"><div class="b" data-h="${(x.agendamentos / mx) * 100}"></div><div class="b a" data-h="${(x.aceitaram / mx) * 100}"></div><div class="b c" data-h="${(x.concluidas / mx) * 100}"></div></div><span class="lb">${x.data.slice(8)}/${x.data.slice(5, 7)}</span></div>`).join('')}</div>
        <div class="legend"><span><i class="lg1"></i>Agendamentos</span><span><i class="lg2"></i>Aceitaram</span><span><i class="lg3"></i>Reservas concluídas</span></div></div></div>
    <div class="grid g3 mt">
      <div class="card"><h2>Motivos de recusa</h2>${barras(p.motivos.recusa, 'bad')}</div>
      <div class="card"><h2>Motivos de aceite</h2>${barras(p.motivos.aceite, 'ok')}</div>
      <div class="card"><h2>Ainda não decidiu</h2>${barras(p.motivos.indeciso, 'warn')}</div>
      <div class="card"><h2>Locação não concluída</h2>${barras(p.motivos.nao_concluida, 'bad')}</div></div>
    <div class="grid mt">
      <div class="card"><h2>Por loja</h2><div class="tbl-wrap"><table><thead><tr><th>Loja</th><th class="num">Agend.</th><th class="num">Ofertados</th><th class="num">Aceitaram</th><th class="num">Reservas</th><th class="num">Conversão</th></tr></thead><tbody>
        ${p.por_loja.map((l) => `<tr><td>${esc(l.loja)}</td><td class="num">${l.agendamentos}</td><td class="num">${l.ofertados}</td><td class="num">${l.aceitaram}</td><td class="num">${l.concluidas}</td><td class="num">${pct(l.conversao_total)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Sem registros no período</td></tr>'}</tbody></table></div></div>
      <div class="card"><h2>Por colaborador <span class="muted small">(contatos no período)</span></h2><div class="tbl-wrap"><table><thead><tr><th>Colaborador</th><th class="num">Contatos</th><th class="num">Ofertas</th><th class="num">Aceites</th><th class="num">Recusas</th><th class="num">Não atend.</th><th class="num">Aceite</th></tr></thead><tbody>
        ${p.por_colaborador.map((c) => `<tr class="${c.contatos ? '' : 'zero'}"><td>${esc(c.nome)}</td><td class="num">${c.contatos}</td><td class="num">${c.ofertas}</td><td class="num">${c.aceites}</td><td class="num">${c.recusas}</td><td class="num">${c.nao_atendeu}</td><td class="num">${pct(c.taxa_aceite)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nenhum colaborador cadastrado</td></tr>'}</tbody></table></div></div></div>
    <div class="card mt"><h2>Atendimento KINTO</h2>
      <div class="rates"><div class="rate"><b>${p.atendimento.aguardando}</b><span>Aguardando atendimento</span></div>
      <div class="rate"><b>${p.atendimento.maior_espera_min == null ? '—' : p.atendimento.maior_espera_min + ' min'}</b><span>Maior espera agora</span></div>
      <div class="rate"><b>${p.atendimento.mediana_assumir_min == null ? '—' : p.atendimento.mediana_assumir_min + ' min'}</b><span>Mediana até assumir</span></div></div>
      <div class="tbl-wrap mt"><table><thead><tr><th>Consultor</th><th class="num">Assumidos</th><th class="num">Concluídas</th><th class="num">Não concluídas</th><th class="num">Mediana até assumir</th></tr></thead><tbody>
      ${p.atendimento.por_atendente.map((a) => `<tr><td>${esc(a.nome)}</td><td class="num">${a.assumidos}</td><td class="num">${a.concluidas}</td><td class="num">${a.nao_concluidas}</td><td class="num">${a.mediana_assumir_min == null ? '—' : a.mediana_assumir_min + ' min'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum atendimento no período</td></tr>'}</tbody></table></div></div>
    <p class="muted small">Contatados = casos com alguma resposta diferente de "Não atendeu". Ofertados = Aceitou, Recusou ou Ainda não decidiu. Receita e reservas vêm do registro de locação feito pelo time KINTO (ou pelo gestor).</p>`;
  applyBars(box);
  const go = $('#goac'); if (go) go.addEventListener('click', () => { S.c.filtro = 'aceitos_sem_reserva'; });
  marcaLive(p.gerado_em.slice(11, 19));
}

/* ---------------- locação (usada na ficha da fila e no caso) ---------------- */
function blocoReserva(rv0, atendimento, bloqueado = false) {
  const rv = rv0 || {};
  return `<div class="sec"><h3>Locação ${rv0 ? badge(rv.status) : ''}</h3>${atendimento ? `<div class="muted small mb">Atendido por ${esc(atendimento.nome)} desde ${fmtHora(atendimento.assumido_em)}</div>` : ''}
    <form data-f="reserva"><fieldset ${bloqueado ? 'disabled' : ''}><div class="row">
      <div class="field"><label>Status</label><select name="status" id="rs">${opts(S.cfg.status_reserva, rv.status, 'Selecione')}</select></div>
      <div class="field" id="rmn"><label>Motivo da não conclusão</label><select name="motivo_nao_conclusao">${opts(S.cfg.motivos_nao_conclusao, rv.motivo_nao_conclusao, 'Selecione')}</select></div></div>
      <div class="row"><div class="field"><label>Retirada</label><input type="date" name="retirada" value="${rv.retirada || ''}"></div><div class="field"><label>Devolução</label><input type="date" name="devolucao" value="${rv.devolucao || ''}"></div></div>
      <div class="row"><div class="field"><label>Modelo</label><input name="modelo" list="mods" value="${esc(rv.modelo || '')}"><datalist id="mods"><option>Yaris</option><option>Yaris Cross</option><option>Corolla</option><option>Corolla Cross</option></datalist></div>
        <div class="field"><label>Diárias <span class="opt">(vazio = calcula pelas datas)</span></label><input type="number" min="0" name="diarias" value="${rv.diarias ?? ''}"></div></div>
      <div class="row"><div class="field"><label>Valor da diária (R$)</label><input type="number" step="0.01" min="0" name="valor_diaria" value="${Number(rv.valor_diaria ?? S.cfg.valor_diaria_padrao).toFixed(2)}"></div>
        <div class="field"><label>Total</label><input disabled value="${rv.valor_total != null ? brl(rv.valor_total) : 'calculado ao salvar'}"></div></div>
      <div class="err" id="rerr"></div>${bloqueado ? '' : '<button class="btn">Salvar locação</button>'}</fieldset></form></div>`;
}
function ligaReserva(root) {
  const sel = $('#rs', root), mn = $('#rmn', root); if (!sel) return;
  const mostra = () => mn.classList.toggle('hidden', sel.value !== 'Não concluída');
  sel.addEventListener('change', mostra); mostra();
}

/* ---------------- atendimento KINTO (fila de clientes que aceitaram) ---------------- */
function viewFila() {
  const gest = S.me.perfil !== 'kinto';
  $('#view').innerHTML = `<div class="page-head"><div><h1>Atendimento KINTO Share</h1>
    <div class="live"><span class="dot" id="livedot"></span><span id="livetxt">Conectando…</span>${gest ? '' : ` · <span>Loja ${esc(S.me.loja_nome)}</span>`}</div></div></div>
    ${gest ? `<div class="filters card"><div class="f"><label>Loja</label><select id="fl">${opts(S.cfg.lojas, S.c.loja, 'Todas')}</select></div></div>` : ''}
    <div id="fbody"><div class="empty">Carregando…</div></div>`;
  if (gest) $('#fl').addEventListener('change', (e) => { S.c.loja = e.target.value; carregaFila(); });
  marcaLive();
  carregaFila();
}
const minDesde = (a, b) => Math.max(0, Math.round((new Date(b.replace(' ', 'T') + 'Z') - new Date(a.replace(' ', 'T') + 'Z')) / 60000));
const fmtEspera = (m) => (m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min');
async function carregaFila() {
  const box = $('#fbody'); if (!box) return;
  let f;
  try { f = await api('/fila' + (S.me.perfil !== 'kinto' && S.c.loja ? '?loja=' + S.c.loja : '')); } catch (e) { return; }
  S.fila = f; S.aguardando = f.itens.filter((x) => x.situacao === 'Aguardando').length;
  const c = $('#cnt'); if (c) { c.textContent = S.aguardando; c.classList.toggle('hidden', !S.aguardando); }
  const aguard = f.itens.filter((x) => x.situacao === 'Aguardando');
  const emAt = f.itens.filter((x) => x.situacao === 'Em atendimento');
  const fim = f.itens.filter((x) => x.reserva_status).reverse();
  const meu = (x) => x.atendente_id === S.me.id;
  const card = (x) => {
    const esp = x.aceito_em ? minDesde(x.aceito_em, f.agora) : 0;
    const quente = x.situacao === 'Aguardando' && esp >= S.cfg.escalona_minutos;
    return `<div class="fcard${quente ? ' late' : ''}${meu(x) ? ' mine' : ''}" data-id="${x.id}">
      <div class="fc-top"><b>${esc(x.cliente_nome)}</b>${badge(x.situacao)}</div>
      <div class="muted small">${S.me.perfil === 'kinto' ? '' : esc(x.loja) + ' · '}Revisão em ${fmtData(x.data_revisao)}</div>
      <div class="small">${x.origem ? badge(x.origem) + ' ' : ''}${esc(x.motivo_aceite || '')}</div>
      <div class="muted small">${x.situacao === 'Aguardando' ? 'Aguardando há ' + fmtEspera(esp) : x.atendente ? 'Atendente: ' + esc(x.atendente) : ''}</div>
      ${x.situacao === 'Aguardando' ? `<button class="btn sm" data-take="${x.id}">Atender este cliente</button>` : `<button class="btn alt sm" data-open="${x.id}">Abrir</button>`}</div>`;
  };
  const col = (t, l, vazio) => `<section><h2 class="colh">${t} <span class="cnt2">${l.length}</span></h2>${l.length ? l.map(card).join('') : `<div class="empty small">${vazio}</div>`}</section>`;
  box.innerHTML = `<div class="kanban">${col('Aguardando', aguard, 'Nenhum cliente aguardando')}${col('Em atendimento', emAt, 'Ninguém em atendimento')}${col('Finalizados (últimos 7 dias)', fim, 'Nada finalizado ainda')}</div>`;
  $$('[data-take]', box).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); assumir(Number(b.dataset.take)); }));
  $$('[data-open]', box).forEach((b) => b.addEventListener('click', () => abreFicha(Number(b.dataset.open))));
  $$('.fcard', box).forEach((c) => c.addEventListener('click', (e) => { if (!e.target.closest('button')) abreFicha(Number(c.dataset.id)); }));
  marcaLive(f.agora.slice(11, 19));
}
async function assumir(id) {
  try { await api(`/fila/${id}/assumir`, { method: 'POST' }); toast('Cliente é seu. Registre a locação na ficha.', 'ok'); carregaFila(); abreFicha(id); }
  catch (e) { toast(e.message, 'err'); carregaFila(); }
}
async function abreFicha(id) {
  let d;
  try { d = await api('/fila/' + id); } catch (e) { toast(e.message, 'err'); carregaFila(); return; }
  const m = modal('Cliente para locação', '', { wide: true });
  const render = () => {
    const c = d.caso, a = d.atendimento, kinto = S.me.perfil === 'kinto';
    const meu = a && a.usuario_id === S.me.id;
    const pode = kinto ? meu : true;
    const botoes = !a && !d.reserva ? (kinto ? `<button class="btn" data-act="take">Atender este cliente</button>` : '')
      : a && !d.reserva && (meu || !kinto) ? `<button class="btn alt sm" data-act="release">Devolver à fila</button>` : '';
    const reat = !kinto && !d.reserva ? `<form class="actions" data-f="reat"><select name="usuario_id" class="inl"><option value="">Passar para…</option>${S.cfg.consultores.filter((x) => x.loja_id === c.loja_id).map((x) => `<option value="${x.id}">${esc(x.nome)}</option>`).join('')}</select><button class="btn alt sm">Atribuir</button></form>` : '';
    m.el.innerHTML = `<div class="ficha"><div><div class="ficha-nome">${esc(c.cliente_nome)}</div>
      <div class="ficha-tel">${fmtTel(c.telefone)}</div>
      <div class="muted small">${esc(c.loja)} · revisão em ${fmtData(c.data_revisao)}</div></div>
      ${d.aceite.origem === 'Ainda não decidiu'
        ? `<div class="hint warnbox"><b>Ainda não decidiu</b> (desde ${fmtHora(d.aceite.aceito_em)}) · registrado por ${esc(d.aceite.registrado_por || '')}<br>Motivo: ${esc(d.aceite.motivo || '')}${d.aceite.observacao ? '<br>Obs.: ' + esc(d.aceite.observacao) : ''}<br><b>Entre em contato com o cliente para apresentar a locação.</b></div>`
        : `<div class="hint"><b>Aceitou a locação</b> em ${fmtHora(d.aceite.aceito_em)} · registrado por ${esc(d.aceite.registrado_por || '')}<br>Motivo: ${esc(d.aceite.motivo || '')}${d.aceite.observacao ? '<br>Obs.: ' + esc(d.aceite.observacao) : ''}</div>`}
      ${a ? `<div class="hint ok">Em atendimento por <b>${esc(a.nome)}</b> desde ${fmtHora(a.assumido_em)}</div>` : ''}
      <div class="actions between">${botoes}${reat}</div>
      ${a || !kinto ? blocoReserva(d.reserva, null, !pode) : '<p class="muted small">Assuma o cliente para registrar a locação.</p>'}</div>`;
    ligaReserva(m.el);
  };
  const acao = async (fn, msg) => { try { d = await fn(); render(); toast(msg, 'ok'); carregaFila(); } catch (e) { toast(e.message, 'err'); } };
  m.el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'take') acao(() => api(`/fila/${id}/assumir`, { method: 'POST' }), 'Cliente é seu');
    if (a.dataset.act === 'release' && confirm('Devolver este cliente à fila para outro consultor atender?')) acao(() => api(`/fila/${id}/liberar`, { method: 'POST' }), 'Devolvido à fila');
  });
  m.el.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target, v = Object.fromEntries(new FormData(f));
    if (f.dataset.f === 'reserva') acao(() => api(`/fila/${id}/reserva`, { method: 'PUT', body: v }), 'Locação salva ✓');
    if (f.dataset.f === 'reat') { if (!v.usuario_id) return toast('Escolha o consultor', 'err'); acao(() => api(`/fila/${id}/reatribuir`, { method: 'POST', body: v }), 'Atribuído'); }
  });
  render();
}

/* ---------------- casos ---------------- */
function viewCasos() {
  $('#view').innerHTML = `<div class="page-head"><div><h1>Casos</h1><div class="muted small">Um caso é um cliente com uma revisão agendada. Clique para ver contatos e registrar a reserva.</div></div>
    <div class="actions"><button class="btn alt sm" id="exc">Exportar casos (CSV)</button></div></div>
    <div class="filters card"><div class="f grow"><label>Buscar por nome ou telefone</label><input id="cq" value="${esc(S.c.q)}" placeholder="Ex.: Maria ou 98888"></div>
      <div class="f"><label>Situação</label><select id="cf"><option value="">Todos</option><option value="aceitos_sem_reserva">Aceitaram, sem reserva</option><option value="com_reserva">Com reserva registrada</option></select></div>
      <div class="f"><label>Loja</label><select id="cl">${opts(S.cfg.lojas, S.c.loja, 'Todas')}</select></div></div>
    <div class="card"><div class="tbl-wrap" id="clist"><div class="empty">Carregando…</div></div></div>`;
  $('#cf').value = S.c.filtro;
  $('#cq').addEventListener('input', debounce((e) => { S.c.q = e.target.value; carregaCasos(); }, 300));
  $('#cf').addEventListener('change', (e) => { S.c.filtro = e.target.value; carregaCasos(); });
  $('#cl').addEventListener('change', (e) => { S.c.loja = e.target.value; carregaCasos(); });
  // exporta o que está filtrado na tela, sem o limite de 300 linhas da lista
  $('#exc').addEventListener('click', (e) => baixarArquivo(`/api/export/casos.csv?q=${encodeURIComponent(S.c.q)}&filtro=${S.c.filtro}&loja=${S.c.loja}`, e.currentTarget));
  carregaCasos();
}
async function carregaCasos() {
  const box = $('#clist'); if (!box) return;
  let rows;
  try { rows = await api(`/casos?q=${encodeURIComponent(S.c.q)}&filtro=${S.c.filtro}&loja=${S.c.loja}`); } catch (e) { return; }
  box.innerHTML = rows.length ? `<table><thead><tr><th>Cliente</th><th>Telefone</th><th>Revisão</th><th>Loja</th><th class="num">Contatos</th><th>Último resultado</th><th>Atendimento KINTO</th><th>Reserva</th></tr></thead><tbody>
    ${rows.map((c) => `<tr class="click" data-id="${c.id}"><td>${esc(c.cliente_nome)}</td><td class="nowrap">${fmtTel(c.telefone)}</td><td>${fmtData(c.data_revisao)}</td><td>${esc(c.loja)}</td><td class="num">${c.n_contatos}</td><td>${c.ultimo_resultado ? badge(c.ultimo_resultado) : ''}</td><td>${esc(c.atendente || '')}</td><td>${c.reserva_status ? badge(c.reserva_status) : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">Nenhum caso encontrado</div>';
  $$('tr.click', box).forEach((tr) => tr.addEventListener('click', () => abreCaso(Number(tr.dataset.id))));
}

async function abreCaso(id) {
  let d = await api('/casos/' + id).catch((e) => { toast(e.message, 'err'); return null; });
  if (!d) return;
  let editando = null, editCaso = false;
  const m = modal('Caso #' + id, '', { wide: true });
  const motivosDe = (res) => S.cfg.motivos.filter((x) => x.resultado === res);
  const render = () => {
    const c = d.caso, rv = d.reserva || {};
    const cab = editCaso ? `<form data-f="caso" class="row"><div class="field"><label>Nome</label><input name="cliente_nome" value="${esc(c.cliente_nome)}"></div><div class="field"><label>Telefone</label><input name="telefone" value="${esc(fmtTel(c.telefone))}"></div>
      <div class="field"><label>Data da revisão</label><input type="date" name="data_revisao" value="${c.data_revisao}"></div><div class="field actions selfend"><button class="btn sm">Salvar</button><button type="button" class="btn alt sm" data-act="cancel-caso">Cancelar</button></div></form>`
      : `<div class="actions between"><div><b>${esc(c.cliente_nome)}</b> · ${fmtTel(c.telefone)}<div class="muted small">Revisão em ${fmtData(c.data_revisao)} · ${esc(c.loja)} · criado em ${fmtHora(c.criado_em)}</div></div><button class="btn alt sm" data-act="edit-caso">Editar dados</button></div>`;
    const lin = d.contatos.map((t) => {
      if (editando === t.id) {
        return `<div class="it"><form data-f="contato" data-id="${t.id}"><div class="row"><div class="field"><label>Etapa</label><select name="etapa">${opts(S.cfg.etapas, t.etapa)}</select></div>
          <div class="field"><label>Resultado</label><select name="resultado" id="er">${opts(S.cfg.resultados, t.resultado)}</select></div></div>
          <div class="field"><label>Motivo</label><select name="motivo_id" id="em">${motivosDe(t.resultado).map((x) => `<option value="${x.id}"${x.id === t.motivo_id ? ' selected' : ''}>${esc(x.descricao)}</option>`).join('')}</select></div>
          <div class="field"><label>Observação</label><textarea name="observacao">${esc(t.observacao || '')}</textarea></div>
          <div class="actions"><button class="btn sm">Salvar</button><button type="button" class="btn alt sm" data-act="cancel-edit">Cancelar</button></div></form></div>`;
      }
      return `<div class="it"><div class="actions between"><div>${badge(t.resultado)} <b>${esc(t.motivo)}</b> <span class="muted small">· ${esc(t.etapa)}</span></div>
        <div class="actions"><button class="btn alt sm" data-act="edit" data-id="${t.id}">Editar</button><button class="btn danger sm" data-act="del" data-id="${t.id}">Inativar</button></div></div>
        ${t.observacao ? `<div class="small">${esc(t.observacao)}</div>` : ''}<div class="muted small">${esc(t.colaborador)} · ${fmtHora(t.criado_em)}</div></div>`;
    }).join('') || '<div class="muted">Sem contatos ativos</div>';
    m.el.innerHTML = `${cab}<div class="sec"><h3>Contatos</h3><div class="tl">${lin}</div></div>
      ${blocoReserva(d.reserva, d.atendimento)}`;
    ligaReserva(m.el);
    const er = $('#er', m.el);
    if (er) er.addEventListener('change', () => { $('#em', m.el).innerHTML = motivosDe(er.value).map((x) => `<option value="${x.id}">${esc(x.descricao)}</option>`).join(''); });
  };
  const salvar = async (fn) => { try { d = await fn(); editando = null; editCaso = false; render(); toast('Salvo ✓', 'ok'); } catch (e) { toast(e.message, 'err'); } };
  m.el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    const act = a.dataset.act;
    if (act === 'edit') { editando = Number(a.dataset.id); render(); }
    if (act === 'cancel-edit') { editando = null; render(); }
    if (act === 'edit-caso') { editCaso = true; render(); }
    if (act === 'cancel-caso') { editCaso = false; render(); }
    if (act === 'del' && confirm('Inativar este contato? Ele deixa de contar nos indicadores e a ação fica na auditoria.')) await salvar(() => api('/contatos/' + a.dataset.id, { method: 'DELETE' }));
  });
  m.el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, v = Object.fromEntries(new FormData(f));
    if (f.dataset.f === 'caso') await salvar(() => api('/casos/' + id, { method: 'PUT', body: v }));
    if (f.dataset.f === 'contato') await salvar(() => api('/contatos/' + f.dataset.id, { method: 'PUT', body: v }));
    if (f.dataset.f === 'reserva') await salvar(() => api(`/casos/${id}/reserva`, { method: 'PUT', body: v }));
  });
  render();
}

/* ---------------- dados e backup ---------------- */
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
async function adminDados() {
  const box = $('#abody');
  const d = await api('/admin/banco');
  const r = d.registros;
  box.innerHTML = `<div class="card mb"><h2>Situação do banco</h2>
    <p class="muted">Tamanho ${fmtBytes(d.tamanho)} · ${r.casos} casos · ${r.contatos} contatos · ${r.reservas} reservas · ${r.atendimentos} atendimentos · ${r.usuarios} usuários · esquema v${d.versao_esquema}</p>
    <p class="muted small">Backup automático diário após ${esc(d.hora_auto)} (mantém os ${d.manter_auto} mais recentes). Pasta no servidor: <code>${esc(d.pasta)}</code></p>
    <div class="actions mt"><button class="btn" id="bk-novo">Fazer backup agora</button>
      <button class="btn alt" id="bk-exp">Exportar banco completo (.db)</button>
      <button class="btn alt" id="bk-imp">Importar banco (.db)…</button>
      <input type="file" id="bk-file" accept=".db,.sqlite,application/octet-stream" class="hidden"></div>
    <div class="hint warnbox mt">O arquivo .db contém todos os dados, inclusive e-mails e senhas (criptografadas) dos usuários. Guarde-o em local seguro. Para planilhas, use os botões CSV do Painel e de Casos.</div></div>
  <div class="card"><h2>Backups guardados</h2><div class="tbl-wrap"><table><thead><tr><th>Arquivo</th><th>Criado em</th><th>Tipo</th><th class="num">Tamanho</th><th></th></tr></thead><tbody>
    ${d.backups.map((b) => `<tr><td class="nowrap">${esc(b.nome)}</td><td class="nowrap">${fmtHora(b.criado_em)}</td><td>${esc(b.tipo_rotulo)}</td><td class="num">${fmtBytes(b.tamanho)}</td>
      <td class="actions"><button class="btn alt sm" data-dl="${esc(b.nome)}">Baixar</button><button class="btn alt sm" data-rs="${esc(b.nome)}">Restaurar</button><button class="btn alt sm" data-rm="${esc(b.nome)}">Excluir</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum backup ainda</td></tr>'}</tbody></table></div></div>`;

  // pede a palavra RESTAURAR antes de substituir os dados
  const confirmar = (titulo, texto, acao) => {
    const m = modal(titulo, `<p>${texto}</p><p class="muted small">Antes de trocar, o sistema guarda uma cópia de segurança dos dados atuais. Todos os usuários serão desconectados.</p>
      <div class="field"><label for="cf">Digite <b>RESTAURAR</b> para confirmar</label><input id="cf" autocomplete="off"></div><div class="err" id="cferr"></div>
      <div class="actions"><button class="btn danger" id="cfok" disabled>Substituir os dados</button><button class="btn alt" id="cfno">Cancelar</button></div>`);
    const inp = $('#cf', m.el), ok = $('#cfok', m.el);
    inp.addEventListener('input', () => { ok.disabled = inp.value.trim() !== 'RESTAURAR'; });
    $('#cfno', m.el).addEventListener('click', m.close);
    ok.addEventListener('click', async () => {
      ok.disabled = true; ok.textContent = 'Restaurando…';
      try {
        const res = await acao();
        m.close(); S.me = null; stopLive();
        renderLogin(); toast('Dados restaurados. Entre novamente. Cópia de segurança: ' + res.backup_de_seguranca, 'ok');
      } catch (e) { $('#cferr', m.el).textContent = e.message; ok.textContent = 'Substituir os dados'; ok.disabled = false; }
    });
    inp.focus();
  };

  $('#bk-novo').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { const b = await api('/admin/backups', { method: 'POST' }); toast('Backup criado: ' + b.nome, 'ok'); adminDados(); } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
  });
  $('#bk-exp').addEventListener('click', (e) => baixarArquivo('/api/admin/banco/exportar', e.target));
  $('#bk-imp').addEventListener('click', () => $('#bk-file').click());
  $('#bk-file').addEventListener('change', (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    confirmar('Importar banco de dados', `Todos os dados atuais serão <b>substituídos</b> pelo conteúdo do arquivo <b>${esc(f.name)}</b> (${fmtBytes(f.size)}).`, async () => {
      const resp = await fetch('/api/admin/banco/importar?confirmo=RESTAURAR', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      let j = {}; try { j = await resp.json(); } catch { /* sem corpo */ }
      if (!resp.ok) throw new Error(j.erro || 'Falha ao importar (erro ' + resp.status + ')');
      return j;
    });
  });
  $$('[data-dl]', box).forEach((b) => b.addEventListener('click', () => baixarArquivo('/api/admin/backups/' + encodeURIComponent(b.dataset.dl), b)));
  $$('[data-rs]', box).forEach((b) => b.addEventListener('click', () => confirmar('Restaurar backup', `Os dados atuais serão substituídos pelo backup <b>${esc(b.dataset.rs)}</b>.`,
    () => api('/admin/backups/' + encodeURIComponent(b.dataset.rs) + '/restaurar', { method: 'POST', body: { confirmo: 'RESTAURAR' } }))));
  $$('[data-rm]', box).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Excluir o backup ' + b.dataset.rm + '?')) return;
    try { await api('/admin/backups/' + encodeURIComponent(b.dataset.rm), { method: 'DELETE' }); toast('Backup excluído', 'ok'); adminDados(); } catch (err) { toast(err.message, 'err'); }
  }));
}

/* ---------------- administração ---------------- */
function viewAdmin() {
  const tab = (k, l) => `<button class="chip${S.adminTab === k ? ' on' : ''}" data-t="${k}">${l}</button>`;
  $('#view').innerHTML = `<div class="page-head"><h1>Administração</h1></div><div class="tabs">${tab('usuarios', 'Usuários')}${tab('lojas', 'Lojas')}${tab('motivos', 'Motivos')}${tab('auditoria', 'Auditoria')}${tab('dados', 'Dados e backup')}</div><div id="abody"></div>`;
  $$('.tabs .chip').forEach((b) => b.addEventListener('click', () => { S.adminTab = b.dataset.t; viewAdmin(); }));
  ({ usuarios: adminUsuarios, lojas: adminLojas, motivos: adminMotivos, auditoria: adminAuditoria, dados: adminDados })[S.adminTab]();
}
async function adminUsuarios() {
  const us = await api('/usuarios'), lojas = await api('/lojas');
  const box = $('#abody');
  box.innerHTML = `<div class="card"><div class="actions between mb"><h2>Usuários</h2><button class="btn sm" id="nu">Novo usuário</button></div><div class="tbl-wrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Loja</th><th>Situação</th><th></th></tr></thead><tbody>
    ${us.map((u) => `<tr class="${u.ativo ? '' : 'muted'}"><td>${esc(u.nome)}</td><td>${esc(u.email)}</td><td>${PERFIL[u.perfil]}</td><td>${esc(u.loja || '—')}</td><td>${u.ativo ? badge('Ativo') : badge('Inativo')}</td>
      <td class="actions"><button class="btn alt sm" data-e="${u.id}">Editar</button><button class="btn alt sm" data-s="${u.id}">Nova senha</button></td></tr>`).join('')}</tbody></table></div></div>`;
  const form = (u) => `<form id="uf"><div class="row"><div class="field"><label>Nome</label><input name="nome" value="${esc(u?.nome || '')}" required></div>
    <div class="field"><label>E-mail</label><input type="email" name="email" value="${esc(u?.email || '')}" ${u ? 'disabled' : 'required'}></div></div>
    <div class="row"><div class="field"><label>Perfil</label><select name="perfil">${opts(Object.keys(PERFIL).map((k) => ({ id: k, nome: PERFIL[k] })), u?.perfil || 'colaborador')}</select></div>
    <div class="field"><label>Loja <span class="opt">(obrigatória para Consultor KINTO)</span></label><select name="loja_id">${opts(lojas.filter((l) => l.ativo).map((l) => ({ id: l.id, nome: l.nome })), u?.loja_id, 'Sem loja')}</select></div></div>
    ${u ? `<div class="field"><label>Situação</label><select name="ativo"><option value="1"${u.ativo ? ' selected' : ''}>Ativo</option><option value="0"${u.ativo ? '' : ' selected'}>Inativo</option></select></div>`
      : '<div class="field"><label>Senha inicial (mínimo 8 caracteres)</label><input type="text" name="senha" minlength="8" required autocomplete="off"></div>'}
    <div class="err" id="uerr"></div><button class="btn">Salvar</button></form>`;
  const abre = (u) => {
    const m = modal(u ? 'Editar usuário' : 'Novo usuário', form(u));
    $('#uf', m.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target));
      try {
        if (u) { v.ativo = v.ativo === '1'; await api('/usuarios/' + u.id, { method: 'PUT', body: v }); } else await api('/usuarios', { method: 'POST', body: v });
        m.close(); toast('Salvo ✓', 'ok'); adminUsuarios(); api('/config').then((c) => { S.cfg = c; });
      } catch (err) { $('#uerr', m.el).textContent = err.message; }
    });
  };
  $('#nu').addEventListener('click', () => abre(null));
  $$('[data-e]', box).forEach((b) => b.addEventListener('click', () => abre(us.find((u) => u.id === Number(b.dataset.e)))));
  $$('[data-s]', box).forEach((b) => b.addEventListener('click', () => {
    const m = modal('Redefinir senha', `<form id="sf"><div class="field"><label>Nova senha (mínimo 8 caracteres)</label><input name="senha" type="text" minlength="8" required autocomplete="off"></div><div class="err" id="serr"></div><button class="btn">Redefinir</button></form>`);
    $('#sf', m.el).addEventListener('submit', async (e) => { e.preventDefault(); try { await api(`/usuarios/${b.dataset.s}/senha`, { method: 'POST', body: { senha: e.target.senha.value } }); m.close(); toast('Senha redefinida', 'ok'); } catch (err) { $('#serr', m.el).textContent = err.message; } });
  }));
}
async function adminLojas() {
  const ls = await api('/lojas'); const box = $('#abody');
  box.innerHTML = `<div class="card"><h2>Lojas</h2><p class="muted small">O e-mail de alerta recebe o aviso quando um cliente que aceitou fica sem atendimento por ${S.cfg.escalona_minutos} minutos em horário comercial (use a caixa compartilhada do time KINTO da loja).</p>
    ${ls.map((l) => `<form class="lojaf${l.ativo ? '' : ' off'}" data-l="${l.id}"><div class="lj-nome"><b>${esc(l.nome)}</b> <span class="muted small">${esc(l.cidade || '')}</span></div>
      <input type="email" name="email_alerta" value="${esc(l.email_alerta || '')}" placeholder="E-mail de alerta da equipe KINTO" aria-label="E-mail de alerta de ${esc(l.nome)}">
      <button class="btn alt sm">Salvar e-mail</button><button type="button" class="btn alt sm" data-t="${l.id}" data-a="${l.ativo ? 0 : 1}">${l.ativo ? 'Desativar' : 'Reativar'}</button></form>`).join('')}
    <form id="lf2" class="row sec"><div class="field"><label>Nova loja</label><input name="nome" required></div><div class="field"><label>Cidade/UF</label><input name="cidade"></div><div class="field"><button class="btn">Adicionar</button></div></form><div class="err" id="lerr2"></div></div>`;
  const recarrega = () => { adminLojas(); api('/config').then((c) => { S.cfg = c; }); };
  $$('[data-t]', box).forEach((b) => b.addEventListener('click', async () => { await api('/lojas/' + b.dataset.t, { method: 'PUT', body: { ativo: Number(b.dataset.a) } }); recarrega(); }));
  $$('form[data-l]', box).forEach((f) => f.addEventListener('submit', async (e) => { e.preventDefault(); try { await api('/lojas/' + f.dataset.l, { method: 'PUT', body: { email_alerta: f.email_alerta.value } }); toast('Salvo ✓', 'ok'); } catch (err) { toast(err.message, 'err'); } }));
  $('#lf2').addEventListener('submit', async (e) => { e.preventDefault(); try { await api('/lojas', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); recarrega(); } catch (err) { $('#lerr2').textContent = err.message; } });
}
async function adminMotivos() {
  const ms = await api('/motivos'); const box = $('#abody');
  box.innerHTML = `<p class="muted small">Desativar um motivo o remove do menu, mas ele continua nos registros antigos. "Exige obs." obriga o colaborador a descrever o motivo.</p><div class="grid g2">${S.cfg.resultados.map((res) => `<div class="card"><h2>${esc(res)}</h2>
    ${ms.filter((m) => m.resultado === res).map((m) => `<div class="mini${m.ativo ? '' : ' off'}"><div>${esc(m.descricao)}</div><label class="small nowrap nomargin"><input type="checkbox" class="chk" data-o="${m.id}" ${m.exige_obs ? 'checked' : ''}> Exige obs.</label>
      <button class="btn alt sm" data-r="${m.id}" data-d="${esc(m.descricao)}">Renomear</button><button class="btn alt sm" data-v="${m.id}" data-a="${m.ativo ? 0 : 1}">${m.ativo ? 'Desativar' : 'Reativar'}</button></div>`).join('')}
    <form class="actions sec" data-n="${esc(res)}"><input name="descricao" placeholder="Novo motivo" class="grow" required><button class="btn sm">Adicionar</button></form></div>`).join('')}</div>`;
  const recarrega = () => { adminMotivos(); api('/config').then((c) => { S.cfg = c; }); };
  $$('[data-o]', box).forEach((c) => c.addEventListener('change', async () => { await api('/motivos/' + c.dataset.o, { method: 'PUT', body: { exige_obs: c.checked } }); toast('Salvo ✓', 'ok'); recarrega(); }));
  $$('[data-v]', box).forEach((b) => b.addEventListener('click', async () => { await api('/motivos/' + b.dataset.v, { method: 'PUT', body: { ativo: Number(b.dataset.a) } }); recarrega(); }));
  $$('[data-r]', box).forEach((b) => b.addEventListener('click', () => {
    const m = modal('Renomear motivo', `<form id="rf"><div class="field"><input name="d" value="${esc(b.dataset.d)}" required></div><button class="btn">Salvar</button></form>`);
    $('#rf', m.el).addEventListener('submit', async (e) => { e.preventDefault(); await api('/motivos/' + b.dataset.r, { method: 'PUT', body: { descricao: e.target.d.value } }); m.close(); recarrega(); });
  }));
  $$('form[data-n]', box).forEach((f) => f.addEventListener('submit', async (e) => { e.preventDefault(); try { await api('/motivos', { method: 'POST', body: { resultado: f.dataset.n, descricao: f.descricao.value } }); recarrega(); } catch (err) { toast(err.message, 'err'); } }));
}
async function adminAuditoria() {
  const a = await api('/auditoria'); const box = $('#abody');
  const resumo = (x) => { try { const o = JSON.parse(x.depois || x.antes || 'null'); return o ? JSON.stringify(o).slice(0, 160) : ''; } catch { return ''; } };
  box.innerHTML = `<div class="card"><h2>Últimas 200 ações</h2><div class="tbl-wrap"><table><thead><tr><th>Quando</th><th>Quem</th><th>Item</th><th>Ação</th><th>Detalhe</th></tr></thead><tbody>
    ${a.map((x) => `<tr><td class="nowrap">${fmtHora(x.quando)}</td><td>${esc(x.usuario || '—')}</td><td>${esc(x.entidade)} #${x.entidade_id ?? ''}</td><td>${esc(x.acao)}</td><td><pre class="json">${esc(resumo(x))}</pre></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nada registrado ainda</td></tr>'}</tbody></table></div></div>`;
}

/* ---------------- início ---------------- */
(async () => {
  try { S.me = await api('/me'); await iniciar(); } catch { renderLogin(); }
})();
