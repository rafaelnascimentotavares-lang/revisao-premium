'use strict';
// SQLite embutido no Node (node:sqlite, Node 22.13+): dispensa compilar módulos nativos no Windows.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Onde fica o banco. Em produção o padrão é FORA da pasta do programa, para que atualizações/redeploys
// (que recriam a pasta do programa) nunca apaguem os dados. Prioridade: DB_PATH > DATA_DIR > padrão.
const os = require('os');
const PASTA_LEGADA = path.join(__dirname, 'data');
function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, 'app.db');
  if (process.env.NODE_ENV === 'production') return path.join(os.homedir(), 'revisao-premium-dados', 'app.db');
  return path.join(PASTA_LEGADA, 'app.db');
}
let DB_PATH = resolveDbPath();
let AVISO_PASTA = null;
if (DB_PATH !== ':memory:') {
  try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); fs.accessSync(path.dirname(DB_PATH), fs.constants.W_OK); } catch (e) {
    if (process.env.DB_PATH || process.env.DATA_DIR) throw new Error('Pasta do banco sem permissão de escrita: ' + path.dirname(DB_PATH));
    AVISO_PASTA = 'Sem permissão em ' + path.dirname(DB_PATH) + '; usando ' + PASTA_LEGADA + ' (os dados podem se perder numa atualização!). Defina DATA_DIR.';
    DB_PATH = path.join(PASTA_LEGADA, 'app.db'); fs.mkdirSync(PASTA_LEGADA, { recursive: true });
  }
}
// Migração única: banco antigo dentro da pasta do programa -> nova pasta de dados (cópia consistente).
let BANCO_MIGRADO_DE = null;
if (DB_PATH !== ':memory:' && !fs.existsSync(DB_PATH)) {
  const antigo = path.join(PASTA_LEGADA, 'app.db');
  if (path.resolve(antigo) !== path.resolve(DB_PATH) && fs.existsSync(antigo)) {
    const t = new DatabaseSync(antigo);
    try { t.exec(`VACUUM INTO '${DB_PATH.replace(/'/g, "''")}'`); BANCO_MIGRADO_DE = antigo; } finally { t.close(); }
  }
}
const BANCO_NOVO = DB_PATH === ':memory:' || !fs.existsSync(DB_PATH); // criado vazio nesta execução

class Banco {
  constructor(arquivo) { this.d = new DatabaseSync(arquivo); }
  exec(sql) { this.d.exec(sql); }
  pragma(p) { this.d.exec('PRAGMA ' + p); }
  prepare(sql) {
    const st = this.d.prepare(sql);
    return {
      run: (...a) => { const r = st.run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
      get: (...a) => st.get(...a),
      all: (...a) => st.all(...a),
    };
  }
  transaction(fn) {
    return (...a) => {
      this.d.exec('BEGIN IMMEDIATE');
      try { const r = fn(...a); this.d.exec('COMMIT'); return r; } catch (e) { try { this.d.exec('ROLLBACK'); } catch { /* já encerrada */ } throw e; }
    };
  }
}
const db = new Banco(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- constantes de negócio ----------
const ETAPAS = ['Agendamento', 'Confirmação'];
const RESULTADOS = ['Aceitou', 'Recusou', 'Ainda não decidiu', 'Não atendeu', 'Não ofertado'];
const OFERTADOS = ['Aceitou', 'Recusou', 'Ainda não decidiu'];
const PERFIS = ['colaborador', 'gestor_loja', 'gestor_kinto', 'kinto'];
const STATUS_RESERVA = ['Concluída', 'Não concluída'];
const MOTIVOS_NAO_CONCLUSAO = ['Cadastro reprovado', 'Sem cartão ou limite', 'Sem disponibilidade', 'Cliente desistiu', 'Outro'];
const VALOR_DIARIA_PADRAO = Number(process.env.VALOR_DIARIA_PADRAO || 174.3);

// ---------- datas no fuso de Brasília ----------
const fmtBR = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const nowBR = (d = new Date()) => fmtBR.format(d); // "2026-10-07 16:25:00"
const hoje = () => nowBR().slice(0, 10);
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T12:00:00Z'));

// ---------- senhas ----------
function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(senha, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function confereSenha(senha, stored) {
  try {
    const [, saltHex, hashHex] = stored.split('$');
    const h = crypto.scryptSync(senha, Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
  } catch { return false; }
}

// ---------- esquema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS lojas (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL UNIQUE, cidade TEXT, ativo INTEGER NOT NULL DEFAULT 1, email_alerta TEXT
);
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, email TEXT NOT NULL UNIQUE, senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL,
  loja_id INTEGER REFERENCES lojas(id), ativo INTEGER NOT NULL DEFAULT 1, criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessoes (
  token_hash TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL REFERENCES usuarios(id), expira_em INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS motivos (
  id INTEGER PRIMARY KEY, resultado TEXT NOT NULL, descricao TEXT NOT NULL, ordem INTEGER NOT NULL DEFAULT 0,
  ativo INTEGER NOT NULL DEFAULT 1, exige_obs INTEGER NOT NULL DEFAULT 0, UNIQUE (resultado, descricao)
);
CREATE TABLE IF NOT EXISTS casos (
  id INTEGER PRIMARY KEY, telefone TEXT NOT NULL, cliente_nome TEXT NOT NULL, data_revisao TEXT NOT NULL,
  loja_id INTEGER REFERENCES lojas(id), usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL, data_local TEXT NOT NULL, escalado_em TEXT
);
CREATE INDEX IF NOT EXISTS ix_casos_tel ON casos(telefone);
CREATE INDEX IF NOT EXISTS ix_casos_data ON casos(data_local);
CREATE TABLE IF NOT EXISTS contatos (
  id INTEGER PRIMARY KEY, caso_id INTEGER NOT NULL REFERENCES casos(id), etapa TEXT NOT NULL,
  resultado TEXT NOT NULL, motivo_id INTEGER NOT NULL REFERENCES motivos(id), observacao TEXT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id), loja_id INTEGER REFERENCES lojas(id),
  criado_em TEXT NOT NULL, data_local TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_contatos_caso ON contatos(caso_id);
CREATE INDEX IF NOT EXISTS ix_contatos_data ON contatos(data_local);
CREATE TABLE IF NOT EXISTS reservas (
  id INTEGER PRIMARY KEY, caso_id INTEGER NOT NULL UNIQUE REFERENCES casos(id), status TEXT NOT NULL,
  motivo_nao_conclusao TEXT, retirada TEXT, devolucao TEXT, modelo TEXT, diarias INTEGER,
  valor_diaria REAL, valor_total REAL, registrado_por INTEGER REFERENCES usuarios(id), atualizado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS atendimentos (
  id INTEGER PRIMARY KEY, caso_id INTEGER NOT NULL UNIQUE REFERENCES casos(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id), loja_id INTEGER REFERENCES lojas(id), assumido_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY, quando TEXT NOT NULL, usuario_id INTEGER, entidade TEXT NOT NULL, entidade_id INTEGER,
  acao TEXT NOT NULL, antes TEXT, depois TEXT
);
`);

// ---------- versão do esquema e migrações ----------
// v1 = modelo original; v2 = colunas email_alerta/escalado_em/motivo_nao_conclusao + índices extras + tabela meta.
const SCHEMA_VERSAO = 2;
const TABELAS = ['lojas', 'usuarios', 'sessoes', 'motivos', 'casos', 'contatos', 'reservas', 'atendimentos', 'auditoria'];
function garanteColuna(tabela, coluna, def) {
  const cols = db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
  if (!cols.includes(coluna)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${def}`);
}
function migrar() {
  db.exec('CREATE TABLE IF NOT EXISTS meta (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)');
  garanteColuna('lojas', 'email_alerta', 'TEXT');
  garanteColuna('casos', 'escalado_em', 'TEXT');
  garanteColuna('reservas', 'motivo_nao_conclusao', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_casos_loja ON casos(loja_id);
    CREATE INDEX IF NOT EXISTS ix_contatos_resultado ON contatos(resultado);
    CREATE INDEX IF NOT EXISTS ix_contatos_usuario ON contatos(usuario_id);
    CREATE INDEX IF NOT EXISTS ix_reservas_status ON reservas(status);
    CREATE INDEX IF NOT EXISTS ix_atend_usuario ON atendimentos(usuario_id);
    CREATE INDEX IF NOT EXISTS ix_audit_quando ON auditoria(quando);`);
  db.prepare('INSERT INTO meta (chave, valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run('schema_versao', String(SCHEMA_VERSAO));
}
migrar();

function auditar(usuarioId, entidade, entidadeId, acao, antes, depois) {
  db.prepare('INSERT INTO auditoria (quando, usuario_id, entidade, entidade_id, acao, antes, depois) VALUES (?,?,?,?,?,?,?)')
    .run(nowBR(), usuarioId, entidade, entidadeId, acao,
      antes == null ? null : JSON.stringify(antes), depois == null ? null : JSON.stringify(depois));
}

// ---------- dados iniciais ----------
const MOTIVOS_PADRAO = {
  'Aceitou': ['Precisa de carro durante a revisão', 'Preço ou desconto', 'Conveniência', 'Já conhece a KINTO', 'Indicação do consultor', 'Outro'],
  'Recusou': ['Tem outro veículo ou carona', 'Prefere app de transporte', 'Preço', 'Revisão rápida (aguarda na loja)', 'Não quer burocracia',
    'Sem cartão de crédito para a pré-autorização', 'Desconhece ou desconfia do serviço', 'Outro'],
  'Ainda não decidiu': ['Vai consultar família ou empresa', 'Quer decidir na confirmação', 'Avalia o preço', 'Outro'],
  'Não atendeu': ['Caixa postal ou não atendeu', 'Número inválido', 'Pediu retorno'],
  'Não ofertado': ['Fora do escopo do piloto', 'Cliente de frota ou empresa', 'Outro'],
};

function semear() {
  if (db.prepare('SELECT COUNT(*) n FROM motivos').get().n === 0) {
    const ins = db.prepare('INSERT INTO motivos (resultado, descricao, ordem, exige_obs) VALUES (?,?,?,?)');
    for (const [res, lista] of Object.entries(MOTIVOS_PADRAO)) {
      lista.forEach((d, i) => ins.run(res, d, i + 1, d === 'Outro' ? 1 : 0));
    }
  }
  if (db.prepare('SELECT COUNT(*) n FROM lojas').get().n === 0) {
    const ins = db.prepare('INSERT INTO lojas (nome, cidade) VALUES (?,?)');
    ins.run('Anápolis', 'Anápolis/GO');
    ins.run('Goiânia', 'Goiânia/GO');
  }
  if (db.prepare('SELECT COUNT(*) n FROM usuarios').get().n === 0) {
    const email = (process.env.ADMIN_EMAIL || 'admin@local').toLowerCase();
    const nome = process.env.ADMIN_NOME || 'Administrador';
    let senha = process.env.ADMIN_PASSWORD;
    let gerada = false;
    if (!senha && process.env.NODE_ENV === 'production') throw new Error('Defina a variável ADMIN_PASSWORD (mín. 10 caracteres) antes de publicar: ela é a senha do primeiro administrador.');
    if (process.env.NODE_ENV === 'production' && senha.length < 10) throw new Error('ADMIN_PASSWORD deve ter pelo menos 10 caracteres.');
    if (!senha) { senha = crypto.randomBytes(9).toString('base64url'); gerada = true; }
    db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?,?,?,?,?)')
      .run(nome, email, hashSenha(senha), 'gestor_kinto', nowBR());
    console.log('\n=== Usuário inicial criado ===');
    console.log('E-mail:', email);
    if (gerada) console.log('Senha provisória (troque no primeiro acesso):', senha);
    console.log('==============================\n');
  }
}
semear();

module.exports = {
  db, DB_PATH, BANCO_NOVO, BANCO_MIGRADO_DE, AVISO_PASTA, SCHEMA_VERSAO, TABELAS, migrar, auditar, nowBR, hoje, addDays, isDate, hashSenha, confereSenha,
  ETAPAS, RESULTADOS, OFERTADOS, PERFIS, STATUS_RESERVA, MOTIVOS_NAO_CONCLUSAO, VALOR_DIARIA_PADRAO,
};
