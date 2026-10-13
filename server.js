'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const D = require('./db');
const { db, DB_PATH, BANCO_NOVO, BANCO_MIGRADO_DE, AVISO_PASTA, SCHEMA_VERSAO, migrar, auditar, nowBR, hoje, addDays, isDate, hashSenha, confereSenha } = D;
const alertas = require('./alertas');

const PROD = process.env.NODE_ENV === 'production';
const app = express();
// Atrás de proxy (Render, Fly, Railway, Caddy, Nginx…): confia no 1º proxy para IP real e https.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
else if (PROD) app.set('trust proxy', 1);
app.disable('x-powered-by');

// verificação de saúde para a hospedagem (sem dados sensíveis)
app.get('/healthz', (req, res) => {
  try { db.prepare('SELECT 1').get(); res.set('Cache-Control', 'no-store').json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});
// em produção só aceita https (a hospedagem termina o TLS e informa pelo proxy)
if (PROD && process.env.FORCAR_HTTPS !== '0') {
  app.use((req, res, next) => (req.secure ? next() : res.redirect(308, 'https://' + req.headers.host + req.originalUrl)));
}
app.use(express.json({ limit: '50kb' }));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow, noarchive', // sistema interno: fora dos buscadores
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  if (PROD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
// Defesa extra contra requisições vindas de outros sites (além do cookie SameSite=Strict)
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const o = req.headers.origin;
  if (o) { let h; try { h = new URL(o).host; } catch { h = null; } if (h !== req.headers.host) return res.status(403).json({ erro: 'Origem não permitida' }); }
  next();
});

class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const bad = (msg) => new HttpError(400, msg);
const wrap = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };

// ---------- sessão e perfis ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SESSAO_MS = 12 * 3600 * 1000;
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1' || process.env.NODE_ENV === 'production';

function lerCookie(h = '') {
  const o = {};
  for (const p of h.split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return o;
}
function auth(req, res, next) {
  const tok = lerCookie(req.headers.cookie).sid;
  if (!tok) return next(new HttpError(401, 'Não autenticado'));
  const u = db.prepare(`SELECT u.*, s.expira_em, l.nome AS loja_nome FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
    LEFT JOIN lojas l ON l.id = u.loja_id WHERE s.token_hash = ?`).get(sha(tok));
  if (!u || u.expira_em < Date.now() || !u.ativo) return next(new HttpError(401, 'Sessão expirada'));
  req.user = u;
  next();
}
const exige = (...perfis) => (req, res, next) => perfis.includes(req.user.perfil) ? next() : next(new HttpError(403, 'Acesso negado'));
const gestor = exige('gestor_loja', 'gestor_kinto');
const admin = exige('gestor_kinto');
const consultor = exige('kinto');
const filaAcesso = exige('kinto', 'gestor_loja', 'gestor_kinto');
const registra = exige('colaborador', 'gestor_loja', 'gestor_kinto'); // consultor KINTO não registra contatos
const ehGestor = (u) => u.perfil === 'gestor_loja' || u.perfil === 'gestor_kinto';
const publico = (u) => ({ id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, loja_id: u.loja_id, loja_nome: u.loja_nome || null });

const tentativas = new Map(); // limitação de tentativas de login: por IP+e-mail (8) e por IP (40) em 15 min
const JANELA = 15 * 60 * 1000;
function limiteLogin(chave, ip) {
  const agora = Date.now();
  for (const k of [chave, ip]) tentativas.set(k, (tentativas.get(k) || []).filter((x) => agora - x < JANELA));
  return tentativas.get(chave).length >= 8 || tentativas.get(ip).length >= 40;
}
setInterval(() => { const a = Date.now(); for (const [k, v] of tentativas) if (!v.some((x) => a - x < JANELA)) tentativas.delete(k); }, 10 * 60 * 1000).unref();
const DUMMY = hashSenha('dummy-password');

app.post('/api/login', wrap((req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');
  const chave = `${req.ip}|${email}`;
  if (limiteLogin(chave, 'ip|' + req.ip)) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
  const ok = confereSenha(senha, u ? u.senha_hash : DUMMY);
  if (!u || !ok || !u.ativo) {
    tentativas.get(chave).push(Date.now()); tentativas.get('ip|' + req.ip).push(Date.now());
    throw new HttpError(401, 'E-mail ou senha inválidos');
  }
  tentativas.delete(chave);
  const tok = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(Date.now());
  db.prepare('INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?,?,?)').run(sha(tok), u.id, Date.now() + SESSAO_MS);
  res.cookie('sid', tok, { httpOnly: true, sameSite: 'strict', secure: COOKIE_SECURE, maxAge: SESSAO_MS, path: '/' });
  const loja = u.loja_id ? db.prepare('SELECT nome FROM lojas WHERE id = ?').get(u.loja_id) : null;
  res.json(publico({ ...u, loja_nome: loja && loja.nome }));
}));

app.post('/api/logout', (req, res) => {
  const tok = lerCookie(req.headers.cookie).sid;
  if (tok) db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(sha(tok));
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(publico(req.user)));

app.post('/api/senha', auth, wrap((req, res) => {
  const { atual, nova } = req.body;
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.user.id);
  if (!confereSenha(String(atual || ''), u.senha_hash)) throw bad('Senha atual incorreta');
  if (String(nova || '').length < 8) throw bad('A nova senha deve ter ao menos 8 caracteres');
  db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(nova), u.id);
  auditar(u.id, 'usuario', u.id, 'troca_senha', null, null);
  res.json({ ok: true });
}));

// ---------- configuração para os formulários ----------
app.get('/api/config', auth, (req, res) => {
  const u = req.user;
  const motivos = db.prepare('SELECT id, resultado, descricao, exige_obs FROM motivos WHERE ativo = 1 ORDER BY resultado, ordem, id').all();
  const lojas = u.perfil === 'kinto'
    ? db.prepare('SELECT id, nome FROM lojas WHERE id = ?').all(u.loja_id)
    : db.prepare('SELECT id, nome FROM lojas WHERE ativo = 1 ORDER BY nome').all();
  const colaboradores = ehGestor(u) ? db.prepare("SELECT id, nome, loja_id FROM usuarios WHERE perfil = 'colaborador' AND ativo = 1 ORDER BY nome").all() : [];
  const consultores = ehGestor(u) ? db.prepare("SELECT id, nome, loja_id FROM usuarios WHERE perfil = 'kinto' AND ativo = 1 ORDER BY nome").all() : [];
  res.json({
    etapas: D.ETAPAS, resultados: D.RESULTADOS, motivos, lojas, colaboradores, consultores,
    status_reserva: D.STATUS_RESERVA, motivos_nao_conclusao: D.MOTIVOS_NAO_CONCLUSAO,
    valor_diaria_padrao: D.VALOR_DIARIA_PADRAO, escalona_minutos: alertas.ESCALA_MIN,
  });
});

// ---------- validações ----------
function normTel(t) {
  let d = String(t || '').replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10 || d.length > 11) return null;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  if (d.length === 11 && d[2] !== '9') return null;
  return d;
}
const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function validaMotivo(resultado, motivoId, observacao) {
  const m = db.prepare('SELECT * FROM motivos WHERE id = ?').get(Number(motivoId));
  if (!m || !m.ativo || m.resultado !== resultado) throw bad('Motivo inválido para o resultado escolhido');
  if (m.exige_obs && !observacao) throw bad('Descreva o motivo no campo Observação');
  return m;
}

// ---------- tempo real (SSE) ----------
// Cada conexão guarda o usuário. Consultor KINTO só recebe eventos da própria loja.
const clientes = new Set();
const vale = (u, lojaId) => u.perfil === 'kinto' ? (lojaId != null && u.loja_id === lojaId) : ehGestor(u);
const SSE_OK = 'update';
let timerAviso = null; const lojasPend = new Set(); let todasPend = false;
function avisa(lojaId = null) {
  if (lojaId == null) todasPend = true; else lojasPend.add(lojaId);
  if (timerAviso) return;
  timerAviso = setTimeout(() => {
    timerAviso = null;
    for (const c of clientes) {
      const u = c.user;
      const alvo = u.perfil === 'kinto' ? (todasPend || lojasPend.has(u.loja_id)) : true;
      if (alvo) c.res.write(`event: ${SSE_OK}\ndata: {}\n\n`);
    }
    lojasPend.clear(); todasPend = false;
  }, 300);
}
// Avisa o time KINTO da loja quando um cliente entra na fila (aceitou ou ficou indeciso) e ainda ninguém assumiu.
function novoAceite(casoId) {
  const c = db.prepare('SELECT c.id, c.cliente_nome, c.loja_id, l.nome AS loja FROM casos c LEFT JOIN lojas l ON l.id = c.loja_id WHERE c.id = ?').get(casoId);
  if (!c) return;
  if (db.prepare('SELECT 1 FROM atendimentos WHERE caso_id = ?').get(casoId) || db.prepare('SELECT 1 FROM reservas WHERE caso_id = ?').get(casoId)) return;
  const e = estadoFila(casoId);
  const msg = `event: aceite\ndata: ${JSON.stringify({ caso_id: c.id, nome: c.cliente_nome, loja: c.loja, origem: e.aceitou ? 'Aceitou' : 'Ainda não decidiu' })}\n\n`;
  for (const cl of clientes) if (cl.user.perfil === 'kinto' && cl.user.loja_id === c.loja_id) cl.res.write(msg);
}
app.get('/api/stream', auth, filaAcesso, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const cli = { res, user: req.user };
  clientes.add(cli);
  const ka = setInterval(() => res.write(': ka\n\n'), 25000);
  req.on('close', () => { clearInterval(ka); clientes.delete(cli); });
});

const temAceite = (alias = 'c') => `EXISTS (SELECT 1 FROM contatos x WHERE x.caso_id = ${alias}.id AND x.ativo = 1 AND x.resultado = 'Aceitou')`;
// Entra na fila KINTO: quem aceitou OU quem está "Ainda não decidiu" (último resultado), para a KINTO entrar em contato.
const ULTIMO = (alias = 'c') => `(SELECT x.resultado FROM contatos x WHERE x.caso_id = ${alias}.id AND x.ativo = 1 ORDER BY x.id DESC LIMIT 1)`;
const paraKinto = (alias = 'c') => `(${temAceite(alias)} OR ${ULTIMO(alias)} = 'Ainda não decidiu')`;
const ACEITE_EM = "(SELECT MIN(x.criado_em) FROM contatos x WHERE x.caso_id = c.id AND x.ativo = 1 AND x.resultado IN ('Aceitou','Ainda não decidiu'))";
const estadoFila = (casoId) => db.prepare(`SELECT ${temAceite('c')} AS aceitou, ${paraKinto('c')} AS na_fila FROM casos c WHERE c.id = ?`).get(casoId) || { aceitou: 0, na_fila: 0 };

// ---------- registro de contato (colaborador e gestores) ----------
app.post('/api/contatos', auth, registra, wrap((req, res) => {
  const b = req.body || {};
  const u = req.user;
  const etapa = String(b.etapa || '');
  if (!D.ETAPAS.includes(etapa)) throw bad('Etapa inválida');
  const nome = txt(b.cliente_nome, 120);
  if (nome.length < 2) throw bad('Informe o nome do cliente');
  const tel = normTel(b.telefone);
  if (!tel) throw bad('Telefone inválido. Informe DDD + número');
  const dataRev = String(b.data_revisao || '');
  if (!isDate(dataRev) || dataRev < addDays(hoje(), -30) || dataRev > addDays(hoje(), 365)) throw bad('Data da revisão inválida');
  const resultado = String(b.resultado || '');
  if (!D.RESULTADOS.includes(resultado)) throw bad('Resultado inválido');
  const obs = txt(b.observacao, 500);
  const motivo = validaMotivo(resultado, b.motivo_id, obs);
  // A loja é a da revisão (escolhida no formulário), não a do colaborador: o agendamento atende as duas lojas.
  const lojaForm = Number(b.loja_id);
  if (!db.prepare('SELECT 1 FROM lojas WHERE id = ? AND ativo = 1').get(lojaForm)) throw bad('Escolha a loja da revisão');

  const tx = db.transaction(() => {
    let caso = db.prepare('SELECT * FROM casos WHERE telefone = ? AND data_revisao = ? ORDER BY id DESC LIMIT 1').get(tel, dataRev);
    if (!caso && etapa === 'Confirmação') {
      caso = db.prepare('SELECT * FROM casos WHERE telefone = ? AND data_local >= ? ORDER BY id DESC LIMIT 1').get(tel, addDays(hoje(), -30));
    }
    const vinculado = !!caso;
    let antes = { aceitou: 0, na_fila: 0 };
    if (caso) {
      const dup = db.prepare(`SELECT 1 FROM contatos WHERE caso_id = ? AND usuario_id = ? AND etapa = ? AND resultado = ?
        AND motivo_id = ? AND ativo = 1 AND criado_em >= ?`).get(caso.id, u.id, etapa, resultado, motivo.id, nowBR(new Date(Date.now() - 30000)));
      if (dup) throw new HttpError(409, 'Este registro já foi enviado');
      antes = estadoFila(caso.id);
    } else {
      const agora = nowBR();
      const r = db.prepare('INSERT INTO casos (telefone, cliente_nome, data_revisao, loja_id, usuario_id, criado_em, data_local) VALUES (?,?,?,?,?,?,?)')
        .run(tel, nome, dataRev, lojaForm, u.id, agora, agora.slice(0, 10));
      caso = { id: Number(r.lastInsertRowid), loja_id: lojaForm };
    }
    const agora = nowBR();
    db.prepare(`INSERT INTO contatos (caso_id, etapa, resultado, motivo_id, observacao, usuario_id, loja_id, criado_em, data_local)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(caso.id, etapa, resultado, motivo.id, obs || null, u.id, caso.loja_id, agora, agora.slice(0, 10));
    const depois = estadoFila(caso.id);
    return { vinculado, casoId: caso.id, lojaId: caso.loja_id, avisar: (!antes.na_fila && depois.na_fila) || (!antes.aceitou && depois.aceitou) };
  });
  const out = tx();
  avisa(out.lojaId);
  if (out.avisar) novoAceite(out.casoId);
  // O colaborador só recebe a confirmação, sem dados da base.
  res.status(201).json({ ok: true, vinculado: out.vinculado });
}));

// Contador do próprio colaborador: só a quantidade de agendamentos que ele registrou hoje (nenhum dado de cliente).
app.get('/api/meu-dia', auth, registra, (req, res) => {
  const d = hoje();
  const n = db.prepare(`SELECT COUNT(DISTINCT caso_id) AS n FROM contatos WHERE usuario_id = ? AND etapa = 'Agendamento' AND ativo = 1 AND data_local = ?`).get(req.user.id, d).n;
  res.json({ data: d, agendamentos: n });
});

// ---------- painel ----------
function intervalo(q) {
  let de = q.de, ate = q.ate;
  if (!isDate(de)) de = hoje();
  if (!isDate(ate)) ate = de > hoje() ? de : hoje();
  if (ate < de) [de, ate] = [ate, de];
  if (addDays(de, 366) < ate) de = addDays(ate, -366);
  return { de, ate };
}
const pct = (a, b) => (b ? a / b : null);
const mediana = (v) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

function painel(q, { anterior = true } = {}) {
  const { de, ate } = intervalo(q);
  const loja = Number(q.loja) || null, colab = Number(q.colab) || null;
  const params = [de, ate];
  let where = 'c.data_local BETWEEN ? AND ?';
  if (loja) { where += ' AND c.loja_id = ?'; params.push(loja); }
  if (colab) { where += ' AND c.usuario_id = ?'; params.push(colab); }

  const casos = db.prepare(`SELECT c.id, c.loja_id, c.data_local FROM casos c WHERE ${where}`).all(...params);
  const contatos = db.prepare(`SELECT t.id, t.caso_id, t.etapa, t.resultado, t.criado_em, m.descricao AS motivo FROM contatos t
    JOIN motivos m ON m.id = t.motivo_id JOIN casos c ON c.id = t.caso_id WHERE t.ativo = 1 AND ${where} ORDER BY t.id`).all(...params);
  const reservas = db.prepare(`SELECT r.* FROM reservas r JOIN casos c ON c.id = r.caso_id WHERE ${where}`).all(...params);

  const porCaso = new Map();
  for (const t of contatos) { if (!porCaso.has(t.caso_id)) porCaso.set(t.caso_id, []); porCaso.get(t.caso_id).push(t); }
  const resPorCaso = new Map(reservas.map((r) => [r.caso_id, r]));

  const lojas = db.prepare('SELECT id, nome FROM lojas').all();
  const nomeLoja = new Map(lojas.map((l) => [l.id, l.nome]));
  const zera = () => ({ concluidas_aceitos: 0, agendamentos: 0, contatados: 0, ofertados: 0, aceitaram: 0, recusaram: 0, indecisos: 0, recuperados: 0, concluidas: 0, nao_concluidas: 0, aceitos_sem_reserva: 0 });
  const tot = zera();
  const porLoja = new Map();
  const dias = new Map();
  for (let d = de; d <= ate; d = addDays(d, 1)) dias.set(d, { data: d, agendamentos: 0, ofertados: 0, aceitaram: 0, concluidas: 0 });

  for (const c of casos) {
    const lista = porCaso.get(c.id) || [];
    const res = lista.map((t) => t.resultado);
    const f = {
      contatado: res.some((r) => r !== 'Não atendeu'),
      ofertado: res.some((r) => D.OFERTADOS.includes(r)),
      aceitou: res.includes('Aceitou'),
      recusou: res.length > 0 && res[res.length - 1] === 'Recusou',
      indeciso: res.includes('Ainda não decidiu'),
    };
    const iInd = res.indexOf('Ainda não decidiu');
    f.recuperado = f.indeciso && res.slice(iInd + 1).includes('Aceitou');
    const rv = resPorCaso.get(c.id);
    const lj = porLoja.get(c.loja_id) || porLoja.set(c.loja_id, zera()).get(c.loja_id);
    for (const alvo of [tot, lj]) {
      alvo.agendamentos++;
      if (f.contatado) alvo.contatados++;
      if (f.ofertado) alvo.ofertados++;
      if (f.aceitou) alvo.aceitaram++;
      if (f.recusou) alvo.recusaram++;
      if (f.indeciso) alvo.indecisos++;
      if (f.recuperado) alvo.recuperados++;
      if (rv && rv.status === 'Concluída') { alvo.concluidas++; if (f.aceitou) alvo.concluidas_aceitos++; }
      if (rv && rv.status === 'Não concluída') alvo.nao_concluidas++;
      if (f.aceitou && !rv) alvo.aceitos_sem_reserva++;
    }
    const dia = dias.get(c.data_local);
    if (dia) { dia.agendamentos++; if (f.ofertado) dia.ofertados++; if (f.aceitou) dia.aceitaram++; if (rv && rv.status === 'Concluída') dia.concluidas++; }
  }

  const concl = reservas.filter((r) => r.status === 'Concluída');
  const diarias = concl.reduce((s, r) => s + (r.diarias || 0), 0);
  const receita = concl.reduce((s, r) => s + (r.valor_total || 0), 0);
  const concluidasDeAceitos = casos.filter((c) => (porCaso.get(c.id) || []).some((t) => t.resultado === 'Aceitou') && resPorCaso.get(c.id)?.status === 'Concluída').length;

  const taxas = (a) => ({
    oferta: pct(a.ofertados, a.agendamentos), aceite: pct(a.aceitaram, a.ofertados), recuperacao: pct(a.recuperados, a.indecisos),
    aceite_reserva: pct(a.concluidas_aceitos, a.aceitaram), nao_conclusao: pct(a.nao_concluidas, a.concluidas + a.nao_concluidas), conversao_total: pct(a.concluidas, a.agendamentos),
  });

  const conta = (resultado) => {
    const m = new Map();
    for (const t of contatos) if (t.resultado === resultado) m.set(t.motivo, (m.get(t.motivo) || 0) + 1);
    return [...m].map(([motivo, n]) => ({ motivo, n })).sort((a, b) => b.n - a.n);
  };

  // motivos das locações não concluídas (reservas do período)
  const mnc = new Map();
  for (const r of reservas) if (r.status === 'Não concluída') { const m = r.motivo_nao_conclusao || 'Sem motivo informado'; mnc.set(m, (mnc.get(m) || 0) + 1); }
  const motivosNaoConcluida = [...mnc].map(([motivo, n]) => ({ motivo, n })).sort((a, b) => b.n - a.n);

  // atividade por colaborador (contatos no período), incluindo quem não registrou nada
  const pc = [de, ate]; let wc = 't.data_local BETWEEN ? AND ?';
  if (loja) { wc += ' AND t.loja_id = ?'; pc.push(loja); }
  if (colab) { wc += ' AND t.usuario_id = ?'; pc.push(colab); }
  const ativ = db.prepare(`SELECT t.usuario_id, t.resultado, COUNT(*) n FROM contatos t WHERE t.ativo = 1 AND ${wc} GROUP BY t.usuario_id, t.resultado`).all(...pc);
  let wu = "u.perfil = 'colaborador' AND u.ativo = 1"; const pu = [];
  if (colab) { wu += ' AND u.id = ?'; pu.push(colab); }
  const colabs = db.prepare(`SELECT u.id, u.nome FROM usuarios u WHERE ${wu} ORDER BY u.nome`).all(...pu);
  const porColab = colabs.map((u) => {
    const x = { id: u.id, nome: u.nome, contatos: 0, ofertas: 0, aceites: 0, recusas: 0, nao_atendeu: 0 };
    for (const a of ativ) if (a.usuario_id === u.id) {
      x.contatos += a.n;
      if (D.OFERTADOS.includes(a.resultado)) x.ofertas += a.n;
      if (a.resultado === 'Aceitou') x.aceites += a.n;
      if (a.resultado === 'Recusou') x.recusas += a.n;
      if (a.resultado === 'Não atendeu') x.nao_atendeu += a.n;
    }
    x.taxa_aceite = pct(x.aceites, x.ofertas);
    return x;
  });

  // atendimento KINTO: fila de espera e tempo até assumir
  const agora = nowBR();
  const aten = db.prepare(`SELECT c.id, a.usuario_id, ua.nome AS atendente, a.assumido_em, ${ACEITE_EM} AS aceito_em, r.status
    FROM casos c JOIN atendimentos a ON a.caso_id = c.id JOIN usuarios ua ON ua.id = a.usuario_id LEFT JOIN reservas r ON r.caso_id = c.id
    WHERE ${where}`).all(...params);
  const aguard = db.prepare(`SELECT c.id, ${ACEITE_EM} AS aceito_em FROM casos c LEFT JOIN atendimentos a ON a.caso_id = c.id LEFT JOIN reservas r ON r.caso_id = c.id
    WHERE ${where} AND a.id IS NULL AND r.id IS NULL AND ${paraKinto('c')}`).all(...params);
  const espera = (x) => (x.aceito_em && x.assumido_em ? Math.max(0, alertas.minutosEntre(x.aceito_em, x.assumido_em)) : null);
  const porAt = new Map();
  for (const x of aten) {
    const a = porAt.get(x.usuario_id) || porAt.set(x.usuario_id, { nome: x.atendente, assumidos: 0, concluidas: 0, nao_concluidas: 0, esperas: [] }).get(x.usuario_id);
    a.assumidos++;
    if (x.status === 'Concluída') a.concluidas++;
    if (x.status === 'Não concluída') a.nao_concluidas++;
    const e = espera(x); if (e != null) a.esperas.push(e);
  }
  const atendimento = {
    aguardando: aguard.length,
    maior_espera_min: aguard.length ? Math.max(...aguard.map((x) => alertas.minutosEntre(x.aceito_em, agora))) : null,
    mediana_assumir_min: mediana(aten.map(espera).filter((e) => e != null)),
    por_atendente: [...porAt.values()].map((a) => ({ nome: a.nome, assumidos: a.assumidos, concluidas: a.concluidas, nao_concluidas: a.nao_concluidas, mediana_assumir_min: mediana(a.esperas) }))
      .sort((a, b) => b.assumidos - a.assumidos),
  };

  // locações concluídas por etapa de origem: etapa do 1º "Aceitou" (se aceitou já no Agendamento, a Confirmação é descartada).
  // Sem "Aceitou" (cliente fechou vindo de "Ainda não decidiu"): etapa do 1º "Ainda não decidiu".
  const locEtapa = { agendamento: 0, confirmacao: 0, sem_origem: 0 };
  for (const r of reservas) {
    if (r.status !== 'Concluída') continue;
    const lista = porCaso.get(r.caso_id) || [];
    const t = lista.find((x) => x.resultado === 'Aceitou') || lista.find((x) => x.resultado === 'Ainda não decidiu');
    if (!t) locEtapa.sem_origem++; else if (t.etapa === 'Agendamento') locEtapa.agendamento++; else locEtapa.confirmacao++;
  }

  // ticket médio e média de diárias (reservas concluídas)
  const ticketMedio = concl.length ? receita / concl.length : null;
  const mediaDiarias = concl.length ? diarias / concl.length : null;
  // tempo do 1º aceite até o registro da reserva (minutos), separado por desfecho
  const tempos = { concluida: [], nao_concluida: [] };
  for (const r of reservas) {
    const lista = porCaso.get(r.caso_id) || [];
    const a = lista.find((t) => t.resultado === 'Aceitou');
    if (!a) continue;
    const m = alertas.minutosEntre(a.criado_em, r.criado_em || r.atualizado_em);
    if (m >= 0) (r.status === 'Concluída' ? tempos.concluida : tempos.nao_concluida).push(m);
  }
  const resumoTempo = (v) => ({ n: v.length, mediana_min: mediana(v), media_min: v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null });
  const tempoReserva = { concluidas: resumoTempo(tempos.concluida), nao_concluidas: resumoTempo(tempos.nao_concluida) };

  // período anterior de mesmo tamanho (mesmos filtros) para comparação
  let anteriorPeriodo = null;
  if (anterior) {
    const dias = Math.round((new Date(ate + 'T12:00:00Z') - new Date(de + 'T12:00:00Z')) / 86400000) + 1;
    const a = painel({ ...q, de: addDays(de, -dias), ate: addDays(de, -1) }, { anterior: false });
    anteriorPeriodo = { periodo: a.periodo, totais: a.totais, taxas: a.taxas, tempo_reserva: a.tempo_reserva };
  }
  return {
    periodo: { de, ate }, gerado_em: agora,
    totais: { ...tot, diarias, receita, concluidas_de_aceitos: concluidasDeAceitos, ticket_medio: ticketMedio, media_diarias: mediaDiarias, locacoes_agendamento: locEtapa.agendamento, locacoes_confirmacao: locEtapa.confirmacao, locacoes_sem_origem: locEtapa.sem_origem },
    taxas: taxas(tot),
    serie: [...dias.values()],
    motivos: { recusa: conta('Recusou'), aceite: conta('Aceitou'), indeciso: conta('Ainda não decidiu'), nao_atendeu: conta('Não atendeu'), nao_ofertado: conta('Não ofertado'), nao_concluida: motivosNaoConcluida },
    por_loja: [...porLoja].map(([id, a]) => ({ loja: nomeLoja.get(id) || '—', ...a, ...taxas(a) })).sort((a, b) => b.agendamentos - a.agendamentos),
    por_colaborador: porColab,
    atendimento,
    tempo_reserva: tempoReserva,
    anterior: anteriorPeriodo,
  };
}
app.get('/api/painel', auth, gestor, wrap((req, res) => res.json(painel(req.query))));

// ---------- casos (gestores) ----------
const CASOS_SELECT = `SELECT c.id, c.telefone, c.cliente_nome, c.data_revisao, c.data_local, c.criado_em, l.nome AS loja, u.nome AS criado_por,
      (SELECT resultado FROM contatos x WHERE x.caso_id = c.id AND x.ativo = 1 ORDER BY x.id DESC LIMIT 1) AS ultimo_resultado,
      (SELECT m.descricao FROM contatos x JOIN motivos m ON m.id = x.motivo_id WHERE x.caso_id = c.id AND x.ativo = 1 ORDER BY x.id DESC LIMIT 1) AS ultimo_motivo,
      (SELECT COUNT(*) FROM contatos x WHERE x.caso_id = c.id AND x.ativo = 1) AS n_contatos,
      r.status AS reserva_status, r.motivo_nao_conclusao, r.retirada, r.devolucao, r.modelo, r.diarias, r.valor_diaria, r.valor_total,
      ua.nome AS atendente, a.assumido_em
    FROM casos c LEFT JOIN lojas l ON l.id = c.loja_id LEFT JOIN usuarios u ON u.id = c.usuario_id LEFT JOIN reservas r ON r.caso_id = c.id
    LEFT JOIN atendimentos a ON a.caso_id = c.id LEFT JOIN usuarios ua ON ua.id = a.usuario_id`;
function filtrosCasos(query) {
  const w = []; const p = [];
  const q = txt(query.q, 80);
  if (q) {
    const dig = q.replace(/\D/g, '');
    if (dig.length >= 3) { w.push('(c.telefone LIKE ? OR c.cliente_nome LIKE ?)'); p.push(`%${dig}%`, `%${q}%`); }
    else { w.push('c.cliente_nome LIKE ?'); p.push(`%${q}%`); }
  }
  if (isDate(query.de)) { w.push('c.data_local >= ?'); p.push(query.de); }
  if (isDate(query.ate)) { w.push('c.data_local <= ?'); p.push(query.ate); }
  if (Number(query.loja)) { w.push('c.loja_id = ?'); p.push(Number(query.loja)); }
  if (query.filtro === 'aceitos_sem_reserva') w.push(`r.id IS NULL AND ${temAceite('c')}`);
  if (query.filtro === 'com_reserva') w.push('r.id IS NOT NULL');
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', p };
}
app.get('/api/casos', auth, gestor, wrap((req, res) => {
  const { where, p } = filtrosCasos(req.query);
  res.json(db.prepare(`${CASOS_SELECT} ${where} ORDER BY c.id DESC LIMIT 300`).all(...p));
}));

function detalheCaso(id) {
  const caso = db.prepare(`SELECT c.*, l.nome AS loja FROM casos c LEFT JOIN lojas l ON l.id = c.loja_id WHERE c.id = ?`).get(id);
  if (!caso) throw new HttpError(404, 'Caso não encontrado');
  const contatos = db.prepare(`SELECT t.*, m.descricao AS motivo, m.exige_obs, u.nome AS colaborador FROM contatos t
    JOIN motivos m ON m.id = t.motivo_id JOIN usuarios u ON u.id = t.usuario_id WHERE t.caso_id = ? AND t.ativo = 1 ORDER BY t.id`).all(id);
  const reserva = db.prepare('SELECT * FROM reservas WHERE caso_id = ?').get(id) || null;
  const atendimento = db.prepare('SELECT a.usuario_id, u.nome, a.assumido_em FROM atendimentos a JOIN usuarios u ON u.id = a.usuario_id WHERE a.caso_id = ?').get(id) || null;
  return { caso, contatos, reserva, atendimento };
}
app.get('/api/casos/:id', auth, gestor, wrap((req, res) => res.json(detalheCaso(Number(req.params.id)))));

app.put('/api/casos/:id', auth, gestor, wrap((req, res) => {
  const id = Number(req.params.id);
  const antes = db.prepare('SELECT * FROM casos WHERE id = ?').get(id);
  if (!antes) throw new HttpError(404, 'Caso não encontrado');
  const nome = txt(req.body.cliente_nome, 120);
  const tel = normTel(req.body.telefone);
  const dataRev = String(req.body.data_revisao || '');
  if (nome.length < 2) throw bad('Informe o nome');
  if (!tel) throw bad('Telefone inválido');
  if (!isDate(dataRev)) throw bad('Data da revisão inválida');
  db.prepare('UPDATE casos SET cliente_nome = ?, telefone = ?, data_revisao = ? WHERE id = ?').run(nome, tel, dataRev, id);
  auditar(req.user.id, 'caso', id, 'edicao', antes, { cliente_nome: nome, telefone: tel, data_revisao: dataRev });
  avisa(antes.loja_id);
  res.json(detalheCaso(id));
}));

app.put('/api/contatos/:id', auth, gestor, wrap((req, res) => {
  const id = Number(req.params.id);
  const antes = db.prepare('SELECT * FROM contatos WHERE id = ? AND ativo = 1').get(id);
  if (!antes) throw new HttpError(404, 'Contato não encontrado');
  const etapa = String(req.body.etapa || antes.etapa);
  const resultado = String(req.body.resultado || '');
  const obs = txt(req.body.observacao, 500);
  if (!D.ETAPAS.includes(etapa)) throw bad('Etapa inválida');
  if (!D.RESULTADOS.includes(resultado)) throw bad('Resultado inválido');
  const m = validaMotivo(resultado, req.body.motivo_id, obs);
  const estAntes = estadoFila(antes.caso_id);
  db.prepare('UPDATE contatos SET etapa = ?, resultado = ?, motivo_id = ?, observacao = ? WHERE id = ?').run(etapa, resultado, m.id, obs || null, id);
  auditar(req.user.id, 'contato', id, 'edicao', antes, { etapa, resultado, motivo_id: m.id, observacao: obs || null });
  avisa(antes.loja_id);
  const estDepois = estadoFila(antes.caso_id);
  if ((!estAntes.na_fila && estDepois.na_fila) || (!estAntes.aceitou && estDepois.aceitou)) novoAceite(antes.caso_id);
  res.json(detalheCaso(antes.caso_id));
}));

app.delete('/api/contatos/:id', auth, gestor, wrap((req, res) => {
  const id = Number(req.params.id);
  const antes = db.prepare('SELECT * FROM contatos WHERE id = ? AND ativo = 1').get(id);
  if (!antes) throw new HttpError(404, 'Contato não encontrado');
  db.prepare('UPDATE contatos SET ativo = 0 WHERE id = ?').run(id); // sem exclusão física
  auditar(req.user.id, 'contato', id, 'inativacao', antes, null);
  avisa(antes.loja_id);
  res.json(detalheCaso(antes.caso_id));
}));

// ---------- reserva (usada pelos gestores e pelo consultor que assumiu o cliente) ----------
function salvarReserva(userId, id, b) {
  b = b || {};
  const status = String(b.status || '');
  if (!D.STATUS_RESERVA.includes(status)) throw bad('Status da reserva inválido');
  let motivoNc = null;
  if (status === 'Não concluída') {
    motivoNc = String(b.motivo_nao_conclusao || '');
    if (!D.MOTIVOS_NAO_CONCLUSAO.includes(motivoNc)) throw bad('Informe o motivo da não conclusão');
  }
  const dt = (v) => { if (!v) return null; if (!isDate(String(v))) throw bad('Data inválida'); return String(v); };
  const retirada = dt(b.retirada), devolucao = dt(b.devolucao);
  if (retirada && devolucao && devolucao < retirada) throw bad('A devolução não pode ser antes da retirada');
  let diarias = b.diarias === '' || b.diarias == null ? null : Math.round(Number(b.diarias));
  if (diarias != null && (!Number.isFinite(diarias) || diarias < 0 || diarias > 365)) throw bad('Diárias inválidas');
  if (diarias == null && retirada && devolucao) diarias = Math.max(1, Math.round((new Date(devolucao) - new Date(retirada)) / 86400000));
  const valorDia = b.valor_diaria === '' || b.valor_diaria == null ? D.VALOR_DIARIA_PADRAO : Number(b.valor_diaria);
  if (!Number.isFinite(valorDia) || valorDia < 0 || valorDia > 100000) throw bad('Valor da diária inválido');
  const total = status === 'Concluída' && diarias != null ? Math.round(diarias * valorDia * 100) / 100 : null;
  const antes = db.prepare('SELECT * FROM reservas WHERE caso_id = ?').get(id);
  db.prepare(`INSERT INTO reservas (caso_id, status, motivo_nao_conclusao, retirada, devolucao, modelo, diarias, valor_diaria, valor_total, registrado_por, atualizado_em, criado_em)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(caso_id) DO UPDATE SET status=excluded.status, motivo_nao_conclusao=excluded.motivo_nao_conclusao,
    retirada=excluded.retirada, devolucao=excluded.devolucao, modelo=excluded.modelo, diarias=excluded.diarias, valor_diaria=excluded.valor_diaria,
    valor_total=excluded.valor_total, registrado_por=excluded.registrado_por, atualizado_em=excluded.atualizado_em`)
    .run(id, status, motivoNc, retirada, devolucao, txt(b.modelo, 60) || null, diarias, valorDia, total, userId, nowBR(), nowBR());
  const depois = db.prepare('SELECT * FROM reservas WHERE caso_id = ?').get(id);
  auditar(userId, 'reserva', depois.id, antes ? 'edicao' : 'criacao', antes, depois);
}
app.put('/api/casos/:id/reserva', auth, gestor, wrap((req, res) => {
  const id = Number(req.params.id);
  const c = db.prepare('SELECT loja_id FROM casos WHERE id = ?').get(id);
  if (!c) throw new HttpError(404, 'Caso não encontrado');
  salvarReserva(req.user.id, id, req.body);
  avisa(c.loja_id);
  res.json(detalheCaso(id));
}));

// ---------- fila KINTO: clientes que aceitaram ----------
// O consultor só enxerga clientes que aceitaram, da própria loja. Nada além disso.
function situacao(r) { return r.reserva_status || (r.atendente_id ? 'Em atendimento' : 'Aguardando'); }
function listaFila(user, q) {
  const w = [`(${paraKinto('c')} OR a.id IS NOT NULL OR r.id IS NOT NULL)`, '(r.id IS NULL OR c.data_local >= ?)']; const p = [addDays(hoje(), -7)];
  if (user.perfil === 'kinto') { w.push('c.loja_id = ?'); p.push(user.loja_id); }
  else if (Number(q.loja)) { w.push('c.loja_id = ?'); p.push(Number(q.loja)); }
  // contato que colocou o cliente na fila: o último "Aceitou"; se nunca aceitou, o último "Ainda não decidiu"
  const ult = (campo, juncao = '') => `(SELECT ${campo} FROM contatos x ${juncao} WHERE x.caso_id = c.id AND x.ativo = 1 AND x.resultado IN ('Aceitou','Ainda não decidiu') ORDER BY (x.resultado = 'Aceitou') DESC, x.id DESC LIMIT 1)`;
  const rows = db.prepare(`SELECT c.id, c.cliente_nome, c.telefone, c.data_revisao, c.loja_id, l.nome AS loja, ${ACEITE_EM} AS aceito_em,
      ${ult('m.descricao', 'JOIN motivos m ON m.id = x.motivo_id')} AS motivo_aceite, ${ult('x.observacao')} AS observacao,
      ${ult('u.nome', 'JOIN usuarios u ON u.id = x.usuario_id')} AS registrado_por, ${ult('x.resultado')} AS origem,
      a.usuario_id AS atendente_id, ua.nome AS atendente, a.assumido_em, r.status AS reserva_status
    FROM casos c LEFT JOIN lojas l ON l.id = c.loja_id LEFT JOIN atendimentos a ON a.caso_id = c.id
    LEFT JOIN usuarios ua ON ua.id = a.usuario_id LEFT JOIN reservas r ON r.caso_id = c.id
    WHERE ${w.join(' AND ')} ORDER BY aceito_em ASC LIMIT 300`).all(...p);
  return rows.map((r) => ({ ...r, situacao: situacao(r) }));
}
app.get('/api/fila', auth, filaAcesso, (req, res) => res.json({ itens: listaFila(req.user, req.query), agora: nowBR() }));

function fichaFila(id, user) {
  const c = db.prepare(`SELECT c.id, c.cliente_nome, c.telefone, c.data_revisao, c.loja_id, l.nome AS loja FROM casos c
    LEFT JOIN lojas l ON l.id = c.loja_id LEFT JOIN atendimentos a ON a.caso_id = c.id LEFT JOIN reservas r ON r.caso_id = c.id
    WHERE c.id = ? AND (${paraKinto('c')} OR a.id IS NOT NULL OR r.id IS NOT NULL)`).get(id);
  // 404 (e não 403) para outra loja: o consultor nem fica sabendo que o cliente existe
  if (!c || (user.perfil === 'kinto' && c.loja_id !== user.loja_id)) throw new HttpError(404, 'Cliente não encontrado');
  const aceite = db.prepare(`SELECT t.resultado AS origem, t.criado_em, t.observacao, m.descricao AS motivo, u.nome AS registrado_por FROM contatos t
    JOIN motivos m ON m.id = t.motivo_id JOIN usuarios u ON u.id = t.usuario_id
    WHERE t.caso_id = ? AND t.ativo = 1 AND t.resultado IN ('Aceitou','Ainda não decidiu') ORDER BY (t.resultado = 'Aceitou') DESC, t.id DESC LIMIT 1`).get(id) || {};
  const atendimento = db.prepare('SELECT a.usuario_id, u.nome, a.assumido_em FROM atendimentos a JOIN usuarios u ON u.id = a.usuario_id WHERE a.caso_id = ?').get(id) || null;
  const reserva = db.prepare('SELECT * FROM reservas WHERE caso_id = ?').get(id) || null;
  const aceito_em = db.prepare(`SELECT ${ACEITE_EM.replace('c.id', '?')} AS v`).get(id).v;
  return { caso: c, aceite: { ...aceite, aceito_em }, atendimento, reserva };
}
app.get('/api/fila/:id', auth, filaAcesso, wrap((req, res) => res.json(fichaFila(Number(req.params.id), req.user))));

app.post('/api/fila/:id/assumir', auth, consultor, wrap((req, res) => {
  const id = Number(req.params.id);
  const ficha = fichaFila(id, req.user); // já recusa cliente de outra loja
  if (ficha.reserva) throw new HttpError(409, 'Este cliente já foi finalizado');
  try {
    db.prepare('INSERT INTO atendimentos (caso_id, usuario_id, loja_id, assumido_em) VALUES (?,?,?,?)').run(id, req.user.id, ficha.caso.loja_id, nowBR());
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT') || (e.errcode && (e.errcode & 0xff) === 19)) {
      const a = db.prepare('SELECT u.nome FROM atendimentos a JOIN usuarios u ON u.id = a.usuario_id WHERE a.caso_id = ?').get(id);
      throw new HttpError(409, `Outro consultor já assumiu este cliente${a ? ' (' + a.nome + ')' : ''}`);
    }
    throw e;
  }
  auditar(req.user.id, 'atendimento', id, 'assumir', null, { loja_id: ficha.caso.loja_id });
  avisa(ficha.caso.loja_id);
  res.json(fichaFila(id, req.user));
}));

app.post('/api/fila/:id/liberar', auth, filaAcesso, wrap((req, res) => {
  const id = Number(req.params.id);
  const ficha = fichaFila(id, req.user);
  const a = ficha.atendimento;
  if (!a) throw new HttpError(409, 'Este cliente não está em atendimento');
  if (req.user.perfil === 'kinto' && a.usuario_id !== req.user.id) throw new HttpError(403, 'Só quem assumiu pode devolver à fila');
  if (ficha.reserva) throw new HttpError(409, 'Este cliente já foi finalizado');
  db.prepare('DELETE FROM atendimentos WHERE caso_id = ?').run(id);
  auditar(req.user.id, 'atendimento', id, 'liberar', a, null);
  avisa(ficha.caso.loja_id);
  res.json(fichaFila(id, req.user));
}));

app.post('/api/fila/:id/reatribuir', auth, gestor, wrap((req, res) => {
  const id = Number(req.params.id);
  const ficha = fichaFila(id, req.user);
  const novo = db.prepare("SELECT * FROM usuarios WHERE id = ? AND perfil = 'kinto' AND ativo = 1").get(Number(req.body.usuario_id));
  if (!novo || novo.loja_id !== ficha.caso.loja_id) throw bad('Escolha um consultor KINTO ativo da loja do cliente');
  if (ficha.reserva) throw new HttpError(409, 'Este cliente já foi finalizado');
  const antes = ficha.atendimento;
  db.prepare(`INSERT INTO atendimentos (caso_id, usuario_id, loja_id, assumido_em) VALUES (?,?,?,?)
    ON CONFLICT(caso_id) DO UPDATE SET usuario_id = excluded.usuario_id, assumido_em = excluded.assumido_em`).run(id, novo.id, novo.loja_id, nowBR());
  auditar(req.user.id, 'atendimento', id, 'reatribuir', antes, { usuario_id: novo.id });
  avisa(ficha.caso.loja_id);
  res.json(fichaFila(id, req.user));
}));

app.put('/api/fila/:id/reserva', auth, filaAcesso, wrap((req, res) => {
  const id = Number(req.params.id);
  const ficha = fichaFila(id, req.user);
  if (req.user.perfil === 'kinto' && (!ficha.atendimento || ficha.atendimento.usuario_id !== req.user.id)) {
    throw new HttpError(403, 'Assuma o cliente antes de registrar a locação');
  }
  salvarReserva(req.user.id, id, req.body);
  avisa(ficha.caso.loja_id);
  res.json(fichaFila(id, req.user));
}));

// ---------- exportação (CSV compatível com Excel pt-BR) ----------
const cel = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita injeção de fórmula
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLinhas = (linhas) => '﻿' + linhas.map((l) => l.map(cel).join(';')).join('\r\n');
function csv(rows, cols) {
  return csvLinhas([cols.map((c) => c[1]), ...rows.map((r) => cols.map((c) => r[c[0]]))]);
}
const num = (n) => (n == null ? '' : String(n).replace('.', ',')); // decimais no padrão do Excel pt-BR
const brNum = (n) => (n == null ? '' : (Math.round(n * 100) / 100).toFixed(2).replace('.', ','));
const brPct = (n) => (n == null ? '' : (n * 100).toFixed(1).replace('.', ',') + '%');
const fmtMin = (m) => (m == null ? '' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`);
const brData = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
const brHora = (d) => (d ? brData(d.slice(0, 10)) + ' ' + d.slice(11, 16) : '');
const baixar = (res, nome, corpo) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nome}"` });
  res.send(corpo);
};
function filtroPeriodo(q, campo) {
  const w = []; const p = [];
  if (isDate(q.de)) { w.push(`${campo} >= ?`); p.push(q.de); }
  if (isDate(q.ate)) { w.push(`${campo} <= ?`); p.push(q.ate); }
  return { w, p };
}
app.get('/api/export/contatos.csv', auth, gestor, wrap((req, res) => {
  const { w, p } = filtroPeriodo(req.query, 't.data_local');
  const rows = db.prepare(`SELECT t.id, t.criado_em, t.etapa, c.cliente_nome, c.telefone, c.data_revisao, l.nome AS loja, u.nome AS colaborador,
    t.resultado, m.descricao AS motivo, t.observacao, t.caso_id FROM contatos t JOIN casos c ON c.id = t.caso_id JOIN motivos m ON m.id = t.motivo_id
    JOIN usuarios u ON u.id = t.usuario_id LEFT JOIN lojas l ON l.id = t.loja_id WHERE t.ativo = 1 ${w.length ? 'AND ' + w.join(' AND ') : ''} ORDER BY t.id`).all(...p);
  baixar(res, 'contatos.csv', csv(rows, [['id', 'ID'], ['caso_id', 'Caso'], ['criado_em', 'Data/hora'], ['etapa', 'Etapa'], ['cliente_nome', 'Cliente'], ['telefone', 'Telefone'],
    ['data_revisao', 'Data da revisão'], ['loja', 'Loja'], ['colaborador', 'Colaborador'], ['resultado', 'Resultado'], ['motivo', 'Motivo'], ['observacao', 'Observação']]));
}));
app.get('/api/export/reservas.csv', auth, gestor, wrap((req, res) => {
  const { w, p } = filtroPeriodo(req.query, 'c.data_local');
  const rows = db.prepare(`SELECT r.caso_id, c.cliente_nome, c.telefone, c.data_revisao, l.nome AS loja, ua.nome AS atendente, r.status, r.motivo_nao_conclusao, r.retirada, r.devolucao,
    r.modelo, r.diarias, r.valor_diaria, r.valor_total FROM reservas r JOIN casos c ON c.id = r.caso_id LEFT JOIN lojas l ON l.id = c.loja_id
    LEFT JOIN atendimentos a ON a.caso_id = c.id LEFT JOIN usuarios ua ON ua.id = a.usuario_id
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY r.id`).all(...p);
  baixar(res, 'reservas.csv', csv(rows, [['caso_id', 'Caso'], ['cliente_nome', 'Cliente'], ['telefone', 'Telefone'], ['data_revisao', 'Data da revisão'], ['loja', 'Loja'], ['atendente', 'Atendente KINTO'], ['status', 'Status'],
    ['motivo_nao_conclusao', 'Motivo de não conclusão'], ['retirada', 'Retirada'], ['devolucao', 'Devolução'], ['modelo', 'Modelo'], ['diarias', 'Diárias'],
    ['valor_diaria', 'Valor da diária'], ['valor_total', 'Valor total']]));
}));

app.get('/api/export/casos.csv', auth, gestor, wrap((req, res) => {
  const { where, p } = filtrosCasos(req.query);
  const rows = db.prepare(`${CASOS_SELECT} ${where} ORDER BY c.id DESC`).all(...p).map((r) => ({
    ...r, data_revisao: brData(r.data_revisao), criado_em: brHora(r.criado_em), assumido_em: brHora(r.assumido_em), retirada: brData(r.retirada), devolucao: brData(r.devolucao),
    valor_diaria: r.valor_diaria == null ? '' : brNum(r.valor_diaria), valor_total: r.valor_total == null ? '' : brNum(r.valor_total),
  }));
  baixar(res, 'casos.csv', csv(rows, [['id', 'Caso'], ['cliente_nome', 'Cliente'], ['telefone', 'Telefone'], ['data_revisao', 'Data da revisão'], ['loja', 'Loja'],
    ['criado_em', 'Criado em'], ['criado_por', 'Criado por'], ['n_contatos', 'Contatos'], ['ultimo_resultado', 'Último resultado'], ['ultimo_motivo', 'Último motivo'],
    ['atendente', 'Atendente KINTO'], ['assumido_em', 'Assumido em'], ['reserva_status', 'Status da reserva'], ['motivo_nao_conclusao', 'Motivo de não conclusão'],
    ['retirada', 'Retirada'], ['devolucao', 'Devolução'], ['modelo', 'Modelo'], ['diarias', 'Diárias'], ['valor_diaria', 'Valor da diária'], ['valor_total', 'Valor total']]));
}));

// Relatório do painel em CSV: os mesmos números da tela (período, loja e colaborador filtrados), em blocos separados por linha em branco.
app.get('/api/export/painel.csv', auth, gestor, wrap((req, res) => {
  const p = painel(req.query);
  const t = p.totais, r = p.taxas, at = p.atendimento;
  const L = [];
  const bloco = (titulo, cab, linhas) => { if (L.length) L.push([]); L.push([titulo]); if (cab) L.push(cab); L.push(...linhas); };
  const lojaNome = Number(req.query.loja) ? (db.prepare('SELECT nome FROM lojas WHERE id = ?').get(Number(req.query.loja)) || {}).nome : 'Todas';
  const colabNome = Number(req.query.colab) ? (db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(Number(req.query.colab)) || {}).nome : 'Todos';
  bloco('Relatório do painel | Revisão Premium', null, [['Período', `${brData(p.periodo.de)} a ${brData(p.periodo.ate)}`], ['Loja', lojaNome || 'Todas'], ['Colaborador', colabNome || 'Todos'], ['Gerado em', brHora(p.gerado_em)]]);
  bloco('Indicadores', ['Indicador', 'Valor'], [['Agendamentos', t.agendamentos], ['Contatados', t.contatados], ['Ofertados', t.ofertados], ['Aceitaram', t.aceitaram], ['Recusaram', t.recusaram],
    ['Ainda não decidiram', t.indecisos], ['Indecisos que aceitaram depois', t.recuperados], ['Reservas concluídas', t.concluidas], ['Reservas não concluídas', t.nao_concluidas],
    ['Aceitaram sem reserva', t.aceitos_sem_reserva], ['Diárias', t.diarias], ['Receita (R$)', brNum(t.receita)],
    ['Locações concluídas — aceitaram no Agendamento', t.locacoes_agendamento], ['Locações concluídas — aceitaram na Confirmação', t.locacoes_confirmacao],
    ['Ticket médio por reserva concluída (R$)', brNum(t.ticket_medio)], ['Média de diárias por reserva concluída', num(t.media_diarias == null ? null : Math.round(t.media_diarias * 10) / 10)]]);
  bloco('Taxas', ['Taxa', 'Valor'], [['Taxa de oferta (ofertados / agendamentos)', brPct(r.oferta)], ['Taxa de aceite (aceitaram / ofertados)', brPct(r.aceite)], ['Recuperação na confirmação', brPct(r.recuperacao)],
    ['Aceite para reserva', brPct(r.aceite_reserva)], ['Locações não concluídas (não concluídas / reservas registradas)', brPct(r.nao_conclusao)], ['Conversão total (reservas / agendamentos)', brPct(r.conversao_total)]]);
  const tr = p.tempo_reserva;
  bloco('Tempo do aceite até a reserva', ['Desfecho', 'Reservas', 'Mediana', 'Média'], [
    ['Concluídas', tr.concluidas.n, fmtMin(tr.concluidas.mediana_min), fmtMin(tr.concluidas.media_min)],
    ['Não concluídas', tr.nao_concluidas.n, fmtMin(tr.nao_concluidas.mediana_min), fmtMin(tr.nao_concluidas.media_min)]]);
  if (p.anterior) {
    const an = p.anterior, ta = an.totais, ra = an.taxas;
    const var_ = (a, b) => (b ? brPct((a - b) / b) : '');
    const lin = (nome, a, b, f = (x) => x) => [nome, f(a), f(b), var_(a, b)];
    bloco(`Comparativo com o período anterior (${brData(an.periodo.de)} a ${brData(an.periodo.ate)})`, ['Indicador', 'Período atual', 'Período anterior', 'Variação'], [
      lin('Agendamentos', t.agendamentos, ta.agendamentos), lin('Ofertados', t.ofertados, ta.ofertados), lin('Aceitaram', t.aceitaram, ta.aceitaram),
      lin('Reservas concluídas', t.concluidas, ta.concluidas), lin('Reservas não concluídas', t.nao_concluidas, ta.nao_concluidas),
      lin('Receita (R$)', t.receita, ta.receita, brNum), lin('Ticket médio (R$)', t.ticket_medio || 0, ta.ticket_medio || 0, brNum),
      ['Taxa de aceite', brPct(r.aceite), brPct(ra.aceite), ''], ['Conversão total', brPct(r.conversao_total), brPct(ra.conversao_total), ''],
      ['Tempo mediano aceite → reserva concluída', fmtMin(tr.concluidas.mediana_min), fmtMin(an.tempo_reserva.concluidas.mediana_min), '']]);
  }
  bloco('Por dia', ['Data', 'Agendamentos', 'Ofertados', 'Aceitaram', 'Reservas concluídas'], p.serie.map((d) => [brData(d.data), d.agendamentos, d.ofertados, d.aceitaram, d.concluidas]));
  for (const [titulo, lista] of [['Motivos de recusa', p.motivos.recusa], ['Motivos de aceite', p.motivos.aceite], ['Motivos de indecisão', p.motivos.indeciso], ['Motivos de não atendeu', p.motivos.nao_atendeu], ['Motivos de não ofertado', p.motivos.nao_ofertado], ['Motivos de locação não concluída', p.motivos.nao_concluida]]) {
    const tot = lista.reduce((s, x) => s + x.n, 0);
    bloco(titulo, ['Motivo', 'Quantidade', '% do total'], lista.map((x) => [x.motivo, x.n, brPct(x.n / tot)]));
  }
  bloco('Por loja', ['Loja', 'Agendamentos', 'Ofertados', 'Aceitaram', 'Reservas concluídas', 'Reservas não concluídas', 'Aceitaram sem reserva', 'Taxa de aceite', '% não concluídas', 'Conversão total'], p.por_loja.map((l) => [l.loja, l.agendamentos, l.ofertados, l.aceitaram, l.concluidas, l.nao_concluidas, l.aceitos_sem_reserva, brPct(l.aceite), brPct(l.nao_conclusao), brPct(l.conversao_total)]));
  bloco('Por colaborador (contatos no período)', ['Colaborador', 'Contatos', 'Ofertas', 'Aceites', 'Recusas', 'Não atendeu', 'Taxa de aceite'], p.por_colaborador.map((c) => [c.nome, c.contatos, c.ofertas, c.aceites, c.recusas, c.nao_atendeu, brPct(c.taxa_aceite)]));
  bloco('Atendimento KINTO', ['Indicador', 'Valor'], [['Aguardando atendimento', at.aguardando], ['Maior espera agora (min)', num(at.maior_espera_min)], ['Mediana até assumir (min)', num(at.mediana_assumir_min)]]);
  bloco('Atendimento por consultor', ['Consultor', 'Assumidos', 'Concluídas', 'Não concluídas', 'Mediana até assumir (min)'], at.por_atendente.map((a) => [a.nome, a.assumidos, a.concluidas, a.nao_concluidas, num(a.mediana_assumir_min)]));
  baixar(res, 'relatorio-painel.csv', csvLinhas(L));
}));

// ---------- administração (Gestor KINTO) ----------
const lojaOuNulo = (v) => {
  if (v === '' || v == null) return null;
  const id = Number(v);
  if (!db.prepare('SELECT 1 FROM lojas WHERE id = ?').get(id)) throw bad('Loja inválida');
  return id;
};
const exigeLoja = (perfil, loja) => { if (perfil === 'kinto' && !loja) throw bad('Consultor KINTO precisa de uma loja'); };
const emailOuNulo = (v) => {
  const e = txt(v, 120).toLowerCase();
  if (!e) return null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw bad('E-mail inválido');
  return e;
};
app.get('/api/usuarios', auth, admin, (req, res) => {
  res.json(db.prepare(`SELECT u.id, u.nome, u.email, u.perfil, u.loja_id, l.nome AS loja, u.ativo FROM usuarios u LEFT JOIN lojas l ON l.id = u.loja_id ORDER BY u.ativo DESC, u.nome`).all());
});
app.post('/api/usuarios', auth, admin, wrap((req, res) => {
  const b = req.body || {};
  const nome = txt(b.nome, 100), email = txt(b.email, 120).toLowerCase(), senha = String(b.senha || '');
  if (nome.length < 2) throw bad('Informe o nome');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('E-mail inválido');
  if (senha.length < 8) throw bad('A senha deve ter ao menos 8 caracteres');
  if (!D.PERFIS.includes(b.perfil)) throw bad('Perfil inválido');
  const loja = lojaOuNulo(b.loja_id);
  exigeLoja(b.perfil, loja);
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw bad('Já existe usuário com este e-mail');
  const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil, loja_id, criado_em) VALUES (?,?,?,?,?,?)').run(nome, email, hashSenha(senha), b.perfil, loja, nowBR());
  auditar(req.user.id, 'usuario', Number(r.lastInsertRowid), 'criacao', null, { nome, email, perfil: b.perfil, loja_id: loja });
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
app.put('/api/usuarios/:id', auth, admin, wrap((req, res) => {
  const id = Number(req.params.id);
  const antes = db.prepare('SELECT id, nome, email, perfil, loja_id, ativo FROM usuarios WHERE id = ?').get(id);
  if (!antes) throw new HttpError(404, 'Usuário não encontrado');
  const b = req.body || {};
  const nome = txt(b.nome, 100) || antes.nome;
  const perfil = b.perfil || antes.perfil;
  if (!D.PERFIS.includes(perfil)) throw bad('Perfil inválido');
  const loja = 'loja_id' in b ? lojaOuNulo(b.loja_id) : antes.loja_id;
  const ativo = 'ativo' in b ? (b.ativo ? 1 : 0) : antes.ativo;
  exigeLoja(perfil, loja);
  if (id === req.user.id && (!ativo || perfil !== 'gestor_kinto')) throw bad('Você não pode desativar nem rebaixar o próprio usuário');
  db.prepare('UPDATE usuarios SET nome = ?, perfil = ?, loja_id = ?, ativo = ? WHERE id = ?').run(nome, perfil, loja, ativo, id);
  if (!ativo || perfil !== antes.perfil || loja !== antes.loja_id) db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(id);
  auditar(req.user.id, 'usuario', id, 'edicao', antes, { nome, perfil, loja_id: loja, ativo });
  res.json({ ok: true });
}));
app.post('/api/usuarios/:id/senha', auth, admin, wrap((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM usuarios WHERE id = ?').get(id)) throw new HttpError(404, 'Usuário não encontrado');
  if (String(req.body.senha || '').length < 8) throw bad('A senha deve ter ao menos 8 caracteres');
  db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(req.body.senha), id);
  db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(id);
  auditar(req.user.id, 'usuario', id, 'redefinicao_senha', null, null);
  res.json({ ok: true });
}));

app.get('/api/lojas', auth, admin, (req, res) => res.json(db.prepare('SELECT * FROM lojas ORDER BY ativo DESC, nome').all()));
app.post('/api/lojas', auth, admin, wrap((req, res) => {
  const nome = txt(req.body.nome, 80);
  if (nome.length < 2) throw bad('Informe o nome da loja');
  if (db.prepare('SELECT 1 FROM lojas WHERE nome = ?').get(nome)) throw bad('Já existe loja com este nome');
  const r = db.prepare('INSERT INTO lojas (nome, cidade, email_alerta) VALUES (?,?,?)').run(nome, txt(req.body.cidade, 80) || null, emailOuNulo(req.body.email_alerta));
  auditar(req.user.id, 'loja', Number(r.lastInsertRowid), 'criacao', null, { nome });
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
app.put('/api/lojas/:id', auth, admin, wrap((req, res) => {
  const id = Number(req.params.id);
  const antes = db.prepare('SELECT * FROM lojas WHERE id = ?').get(id);
  if (!antes) throw new HttpError(404, 'Loja não encontrada');
  const nome = txt(req.body.nome, 80) || antes.nome;
  const ativo = 'ativo' in req.body ? (req.body.ativo ? 1 : 0) : antes.ativo;
  const cidade = 'cidade' in req.body ? txt(req.body.cidade, 80) || null : antes.cidade;
  const email = 'email_alerta' in req.body ? emailOuNulo(req.body.email_alerta) : antes.email_alerta;
  db.prepare('UPDATE lojas SET nome = ?, cidade = ?, ativo = ?, email_alerta = ? WHERE id = ?').run(nome, cidade, ativo, email, id);
  auditar(req.user.id, 'loja', id, 'edicao', antes, { nome, cidade, ativo, email_alerta: email });
  res.json({ ok: true });
}));

app.get('/api/motivos', auth, admin, (req, res) => res.json(db.prepare('SELECT * FROM motivos ORDER BY resultado, ordem, id').all()));
app.post('/api/motivos', auth, admin, wrap((req, res) => {
  const resultado = String(req.body.resultado || ''), desc = txt(req.body.descricao, 80);
  if (!D.RESULTADOS.includes(resultado)) throw bad('Resultado inválido');
  if (desc.length < 2) throw bad('Informe a descrição');
  if (db.prepare('SELECT 1 FROM motivos WHERE resultado = ? AND descricao = ?').get(resultado, desc)) throw bad('Este motivo já existe');
  const ordem = db.prepare('SELECT COALESCE(MAX(ordem),0)+1 n FROM motivos WHERE resultado = ?').get(resultado).n;
  const r = db.prepare('INSERT INTO motivos (resultado, descricao, ordem, exige_obs) VALUES (?,?,?,?)').run(resultado, desc, ordem, req.body.exige_obs ? 1 : 0);
  auditar(req.user.id, 'motivo', Number(r.lastInsertRowid), 'criacao', null, { resultado, desc });
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
app.put('/api/motivos/:id', auth, admin, wrap((req, res) => {
  const id = Number(req.params.id);
  const antes = db.prepare('SELECT * FROM motivos WHERE id = ?').get(id);
  if (!antes) throw new HttpError(404, 'Motivo não encontrado');
  const desc = txt(req.body.descricao, 80) || antes.descricao;
  const ativo = 'ativo' in req.body ? (req.body.ativo ? 1 : 0) : antes.ativo;
  const ordem = 'ordem' in req.body ? Math.round(Number(req.body.ordem)) || antes.ordem : antes.ordem;
  const exige = 'exige_obs' in req.body ? (req.body.exige_obs ? 1 : 0) : antes.exige_obs;
  db.prepare('UPDATE motivos SET descricao = ?, ativo = ?, ordem = ?, exige_obs = ? WHERE id = ?').run(desc, ativo, ordem, exige, id);
  auditar(req.user.id, 'motivo', id, 'edicao', antes, { descricao: desc, ativo, ordem, exige_obs: exige });
  res.json({ ok: true });
}));

app.get('/api/auditoria', auth, admin, (req, res) => {
  res.json(db.prepare(`SELECT a.*, u.nome AS usuario FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id ORDER BY a.id DESC LIMIT 200`).all());
});

// ---------- banco de dados: backup, exportação e importação (somente gestor KINTO) ----------
const bk = require('./backup');
const PASTA_BK = bk.pastaBackups(DB_PATH);
let restaurando = false;
const CONFIRMA = 'RESTAURAR';

function backupAgora(tipo) {
  const b = bk.criarBackup(db.d, PASTA_BK, tipo, nowBR());
  bk.aplicarRetencao(PASTA_BK);
  return b;
}
function resumoBanco() {
  const n = {};
  for (const t of ['usuarios', 'casos', 'contatos', 'reservas', 'atendimentos', 'auditoria']) n[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  let tamanho = 0; try { if (DB_PATH !== ':memory:') tamanho = fs.statSync(DB_PATH).size; } catch { /* sem arquivo */ }
  return { versao_esquema: SCHEMA_VERSAO, tamanho, registros: n };
}
// aplica a restauração a partir de um arquivo já validado: backup de segurança -> troca dos dados -> encerra sessões
function aplicarRestauracao(req, caminho, origem) {
  if (restaurando) throw new HttpError(409, 'Já existe uma restauração em andamento.');
  restaurando = true;
  try {
    let resumo;
    try { resumo = bk.validarArquivo(caminho, SCHEMA_VERSAO); } catch (e) { throw new HttpError(400, e.message); }
    const seguranca = backupAgora('pre-restauracao');
    try { bk.restaurar(db.d, caminho); } catch (e) { throw new HttpError(400, 'Restauração não aplicada: ' + e.message + ' Os dados atuais foram mantidos.'); }
    migrar();
    db.prepare('DELETE FROM sessoes').run();
    auditar(req.user.id, 'banco', null, 'restauracao', null, { origem, backup_de_seguranca: seguranca.nome, registros: resumo });
    avisa();
    return { ok: true, backup_de_seguranca: seguranca.nome, registros: resumo };
  } finally { restaurando = false; }
}

app.get('/api/admin/banco', auth, admin, (req, res) => {
  res.json({ ...resumoBanco(), pasta: PASTA_BK, hora_auto: bk.HORA, manter_auto: bk.RETENCAO.auto, backups: bk.listar(PASTA_BK) });
});
app.post('/api/admin/backups', auth, admin, wrap((req, res) => {
  const b = backupAgora('manual');
  auditar(req.user.id, 'banco', null, 'backup_manual', null, { arquivo: b.nome });
  res.status(201).json(b);
}));
app.get('/api/admin/backups/:nome', auth, admin, (req, res) => {
  const c = bk.caminhoSeguro(PASTA_BK, req.params.nome);
  if (!c) return res.status(404).json({ erro: 'Backup não encontrado' });
  auditar(req.user.id, 'banco', null, 'backup_baixado', null, { arquivo: req.params.nome });
  res.download(c, req.params.nome);
});
app.delete('/api/admin/backups/:nome', auth, admin, wrap((req, res) => {
  const c = bk.caminhoSeguro(PASTA_BK, req.params.nome);
  if (!c) throw new HttpError(404, 'Backup não encontrado');
  fs.unlinkSync(c);
  auditar(req.user.id, 'banco', null, 'backup_excluido', null, { arquivo: req.params.nome });
  res.json({ ok: true });
}));
app.post('/api/admin/backups/:nome/restaurar', auth, admin, wrap((req, res) => {
  if (req.body.confirmo !== CONFIRMA) throw new HttpError(400, `Para confirmar, digite ${CONFIRMA}.`);
  const c = bk.caminhoSeguro(PASTA_BK, req.params.nome);
  if (!c) throw new HttpError(404, 'Backup não encontrado');
  res.json(aplicarRestauracao(req, c, req.params.nome));
}));
// exporta um arquivo .db completo (todos os dados, inclusive usuários e auditoria)
app.get('/api/admin/banco/exportar', auth, admin, wrap((req, res) => {
  const tmp = path.join(os.tmpdir(), `rp-export-${crypto.randomBytes(6).toString('hex')}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  auditar(req.user.id, 'banco', null, 'exportacao', null, null);
  const nome = `revisao-premium-${nowBR().slice(0, 10)}.db`;
  res.download(tmp, nome, () => fs.unlink(tmp, () => {}));
}));
// importa um arquivo .db (corpo binário). Substitui todos os dados após backup de segurança.
app.post('/api/admin/banco/importar', auth, admin, express.raw({ type: '*/*', limit: '200mb' }), wrap((req, res) => {
  if (req.query.confirmo !== CONFIRMA) throw new HttpError(400, `Para confirmar, digite ${CONFIRMA}.`);
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Nenhum arquivo recebido.');
  const tmp = path.join(os.tmpdir(), `rp-import-${crypto.randomBytes(6).toString('hex')}.db`);
  fs.writeFileSync(tmp, req.body);
  try { res.json(aplicarRestauracao(req, tmp, 'arquivo enviado')); } finally { fs.unlink(tmp, () => {}); }
}));
// ---------- arquivos estáticos e erros ----------
app.use('/api', (req, res) => res.status(404).json({ erro: 'Rota não encontrada' }));
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ erro: err.message });
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) return res.status(400).json({ erro: 'Requisição inválida' });
  console.error(err);
  res.status(500).json({ erro: 'Erro interno' });
});


// ---------- proteção dos dados em atualizações ----------
// 1) Banco recém-criado + há backups na pasta de backups => recupera o mais recente (ex.: pasta do banco foi apagada).
// 2) Código mudou desde a última execução (atualização/redeploy) => backup "antes de atualização" ANTES de usar o banco.
function assinaturaCodigo() {
  const h = crypto.createHash('sha256');
  for (const f of ['server.js', 'db.js', 'alertas.js', 'backup.js', 'public/app.js', 'public/style.css']) { try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch { /* ausente */ } }
  return h.digest('hex').slice(0, 12);
}
function protegerDados(log = console.log) {
  const r = { recuperado: null, backup_atualizacao: null };
  if (AVISO_PASTA) log('ATENÇÃO: ' + AVISO_PASTA);
  if (BANCO_MIGRADO_DE) log('Banco antigo copiado para a nova pasta de dados: ' + DB_PATH);
  if (DB_PATH === ':memory:') return r;
  if (BANCO_NOVO) {
    const ultimo = bk.listar(PASTA_BK)[0];
    if (ultimo) {
      try {
        const c = path.join(PASTA_BK, ultimo.nome);
        bk.validarArquivo(c, SCHEMA_VERSAO);
        bk.restaurar(db.d, c); migrar();
        r.recuperado = ultimo.nome; log('Banco novo detectado: dados recuperados do backup ' + ultimo.nome);
      } catch (e) { log('Não foi possível recuperar do backup ' + ultimo.nome + ': ' + e.message); }
    }
  }
  const atual = assinaturaCodigo();
  const reg = db.prepare("SELECT valor FROM meta WHERE chave = 'codigo'").get();
  if (reg && reg.valor !== atual && db.prepare('SELECT COUNT(*) n FROM casos').get().n > 0) {
    try { r.backup_atualizacao = bk.criarBackup(db.d, PASTA_BK, 'atualizacao', nowBR()).nome; bk.aplicarRetencao(PASTA_BK); log('Atualização detectada: backup ' + r.backup_atualizacao); } catch (e) { log('Falha no backup de atualização: ' + e.message); }
  }
  db.prepare("INSERT INTO meta (chave, valor) VALUES ('codigo', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(atual);
  return r;
}
app.protegerDados = protegerDados; // exposto para os testes
app.escalar = alertas.escalar; // exposto para os testes
module.exports = app;
if (require.main === module) {
  protegerDados();
  const porta = Number(process.env.PORT || 3000);
  const srv = app.listen(porta, '0.0.0.0', () => console.log(`Revisão Premium rodando na porta ${porta}${PROD ? ' (produção)' : ''}`));
  srv.requestTimeout = 5 * 60 * 1000; // importação de banco grande
  const rotinaBackup = () => { try { if (bk.precisaAutomatico(PASTA_BK, nowBR())) { const b = backupAgora('auto'); console.log('Backup automático:', b.nome); } } catch (e) { console.error('backup automático:', e.message); } };
  rotinaBackup(); setInterval(rotinaBackup, 10 * 60 * 1000);
  setInterval(() => alertas.escalar().catch((e) => console.error('escalonamento:', e.message)), 60 * 1000);
  // desligamento limpo (deploys e reinícios da hospedagem): fecha conexões e consolida o banco
  const sair = () => {
    console.log('Encerrando…');
    for (const c of clientes) { try { c.res.end(); } catch { /* ok */ } }
    srv.close(() => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ok */ } process.exit(0); });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', sair); process.on('SIGINT', sair);
}
