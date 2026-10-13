'use strict';
// Backup, exportação e restauração do banco SQLite.
//  - Módulo: usado pelo servidor (backup automático diário, manual, restauração).
//  - CLI:    npm run backup   (cópia consistente mesmo com o servidor em uso)
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const TIPOS = { auto: 'automático', manual: 'manual', 'pre-restauracao': 'antes de restaurar', atualizacao: 'antes de atualização' };
const RETENCAO = { auto: Number(process.env.BACKUP_KEEP || 14), manual: 30, 'pre-restauracao': 5, atualizacao: 10 };
const HORA = process.env.BACKUP_HORA || '02:00';
const NOME_OK = /^app-(\d{8})-(\d{6})-(auto|manual|pre-restauracao|atualizacao)\.db$/;

function pastaBackups(dbPath) {
  if (process.env.BACKUP_DIR) return process.env.BACKUP_DIR;
  const base = dbPath && dbPath !== ':memory:' ? path.dirname(dbPath) : path.join(__dirname, 'data');
  return path.join(base, 'backups');
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const carimbo = (agoraBR) => agoraBR.replace(/[-: ]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2'); // "2026-10-13 08:12:00" -> 20261013-081200

// Cópia consistente (VACUUM INTO) a partir de uma conexão aberta. Retorna { nome, caminho, tamanho }.
function criarBackup(conn, pasta, tipo, agoraBR) {
  if (!TIPOS[tipo]) throw new Error('Tipo de backup inválido');
  fs.mkdirSync(pasta, { recursive: true });
  // dois backups no mesmo segundo (ex.: manual + cópia de segurança): avança 1 s no nome
  let t = new Date(agoraBR.replace(' ', 'T') + 'Z');
  let nome = `app-${carimbo(t.toISOString().slice(0, 19).replace('T', ' '))}-${tipo}.db`;
  while (fs.existsSync(path.join(pasta, nome))) {
    t = new Date(t.getTime() + 1000);
    nome = `app-${carimbo(t.toISOString().slice(0, 19).replace('T', ' '))}-${tipo}.db`;
  }
  const caminho = path.join(pasta, nome);
  conn.exec(`VACUUM INTO ${q(caminho)}`);
  return { nome, caminho, tamanho: fs.statSync(caminho).size };
}

function listar(pasta) {
  if (!fs.existsSync(pasta)) return [];
  return fs.readdirSync(pasta).map((nome) => {
    const m = NOME_OK.exec(nome); if (!m) return null;
    const st = fs.statSync(path.join(pasta, nome));
    const d = m[1], h = m[2];
    return { nome, tipo: m[3], tipo_rotulo: TIPOS[m[3]], tamanho: st.size,
      criado_em: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${h.slice(0, 2)}:${h.slice(2, 4)}:${h.slice(4, 6)}` };
  }).filter(Boolean).sort((a, b) => b.nome.localeCompare(a.nome));
}

function aplicarRetencao(pasta) {
  const apagados = [];
  const todos = listar(pasta);
  for (const tipo of Object.keys(TIPOS)) {
    todos.filter((b) => b.tipo === tipo).slice(Math.max(1, RETENCAO[tipo])).forEach((b) => {
      try { fs.unlinkSync(path.join(pasta, b.nome)); apagados.push(b.nome); } catch { /* em uso */ }
    });
  }
  return apagados;
}

function caminhoSeguro(pasta, nome) {
  if (!NOME_OK.test(String(nome))) return null;
  const c = path.join(pasta, nome);
  return fs.existsSync(c) ? c : null;
}

// Garante 1 backup automático por dia: roda depois de HORA e recupera o dia se o servidor estava desligado.
function precisaAutomatico(pasta, agoraBR) {
  if (agoraBR.slice(11, 16) < HORA) return false;
  const dia = agoraBR.slice(0, 10);
  return !listar(pasta).some((b) => b.tipo === 'auto' && b.criado_em.slice(0, 10) === dia);
}

// ---------- validação e restauração ----------
const TABELAS_DADOS = ['lojas', 'usuarios', 'motivos', 'casos', 'contatos', 'reservas', 'atendimentos', 'auditoria'];

function colunas(conn, tabela, schema = 'main') {
  return conn.prepare(`PRAGMA ${schema}.table_info(${tabela})`).all().map((c) => c.name);
}

// Confere se o arquivo é um banco desta aplicação. Lança Error com mensagem em português.
function validarArquivo(caminho, atual, schemaMax) {
  const fd = fs.openSync(caminho, 'r');
  const cab = Buffer.alloc(16); fs.readSync(fd, cab, 0, 16, 0); fs.closeSync(fd);
  if (cab.toString('latin1') !== 'SQLite format 3\0') throw new Error('O arquivo não é um banco SQLite (.db) válido.');
  let imp;
  try {
    imp = new DatabaseSync(caminho, { readOnly: true });
    const ic = imp.prepare('PRAGMA integrity_check').all();
    if (ic.length !== 1 || Object.values(ic[0])[0] !== 'ok') throw new Error('O arquivo está corrompido (falhou na verificação de integridade).');
    const tabs = imp.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    const falta = TABELAS_DADOS.filter((t) => !tabs.includes(t));
    if (falta.length) throw new Error('Este arquivo não é um backup do Revisão Premium (faltam tabelas: ' + falta.join(', ') + ').');
    if (tabs.includes('meta')) {
      const v = imp.prepare("SELECT valor FROM meta WHERE chave='schema_versao'").get();
      if (v && Number(v.valor) > schemaMax) throw new Error('O backup é de uma versão mais nova do sistema. Atualize o sistema antes de restaurar.');
    }
    // colunas obrigatórias que o backup precisa ter (as demais assumem o padrão)
    const minimo = { casos: ['id', 'telefone', 'cliente_nome', 'data_revisao'], contatos: ['id', 'caso_id', 'resultado'], usuarios: ['id', 'email', 'senha_hash', 'perfil'], lojas: ['id', 'nome'] };
    for (const [t, cols] of Object.entries(minimo)) {
      const ex = colunas(imp, t);
      const f = cols.filter((c) => !ex.includes(c));
      if (f.length) throw new Error(`Backup incompatível: tabela ${t} sem a coluna ${f.join(', ')}.`);
    }
    const adm = imp.prepare("SELECT COUNT(*) n FROM usuarios WHERE perfil='gestor_kinto' AND ativo=1").get().n;
    if (!adm) throw new Error('O backup não tem nenhum administrador (gestor KINTO) ativo; restaurar bloquearia o acesso ao sistema.');
    const resumo = {};
    for (const t of TABELAS_DADOS) resumo[t] = imp.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    return resumo;
  } catch (e) {
    if (/not a database|file is not|malformed/i.test(e.message)) throw new Error('O arquivo está corrompido ou não é um banco SQLite.');
    throw e;
  } finally { try { imp && imp.close(); } catch { /* ok */ } }
}

// Substitui TODOS os dados pelos do arquivo. Transacional: se algo falhar, nada muda.
function restaurar(conn, caminho) {
  conn.exec(`ATTACH DATABASE ${q(caminho)} AS imp`);
  try {
    conn.exec('PRAGMA foreign_keys = OFF');
    conn.exec('BEGIN IMMEDIATE');
    try {
      conn.exec('DELETE FROM sessoes');
      // filhos primeiro ao apagar; pais primeiro ao inserir
      for (const t of [...TABELAS_DADOS].reverse()) conn.exec(`DELETE FROM main.${t}`);
      for (const t of TABELAS_DADOS) {
        const dest = colunas(conn, t), orig = colunas(conn, t, 'imp');
        const comuns = dest.filter((c) => orig.includes(c)).join(', ');
        conn.exec(`INSERT INTO main.${t} (${comuns}) SELECT ${comuns} FROM imp.${t}`);
      }
      const viol = conn.prepare('PRAGMA foreign_key_check').all();
      if (viol.length) throw new Error('Backup inconsistente (' + viol.length + ' vínculo(s) quebrado(s)); nada foi alterado.');
      conn.exec('COMMIT');
    } catch (e) { try { conn.exec('ROLLBACK'); } catch { /* já encerrada */ } throw e; }
  } finally {
    try { conn.exec('DETACH DATABASE imp'); } catch { /* ok */ }
    conn.exec('PRAGMA foreign_keys = ON');
  }
}

module.exports = { TIPOS, HORA, RETENCAO, pastaBackups, criarBackup, listar, aplicarRetencao, caminhoSeguro, precisaAutomatico, validarArquivo, restaurar };

// ---------- CLI ----------
if (require.main === module) {
  const origem = require('./db').DB_PATH;
  if (origem !== ':memory:' && !fs.existsSync(origem)) { console.error('Banco não encontrado:', origem); process.exit(1); }
  const pasta = pastaBackups(origem);
  try {
    const conn = new DatabaseSync(origem);
    const agora = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
    const b = criarBackup(conn, pasta, 'manual', agora);
    aplicarRetencao(pasta);
    console.log('Backup criado:', b.caminho);
  } catch (e) { console.error('Falha no backup:', e.message); process.exit(1); }
}
