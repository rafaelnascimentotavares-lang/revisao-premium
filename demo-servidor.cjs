'use strict';
// Demonstração local: sobe o sistema com um banco separado (data/demo.db) e usuários de exemplo.
// Uso: npm run demo   →  http://localhost:3000   (não use este banco em produção)
process.env.DB_PATH = process.env.DB_PATH || require('path').join(__dirname, 'data', 'demo.db');
process.env.ADMIN_EMAIL = 'admin@demo.com';
process.env.ADMIN_PASSWORD = 'demo-12345';
process.env.ESCALONA_MINUTOS = process.env.ESCALONA_MINUTOS || '2';
const app = require('./server');
const { db, hoje } = require('./db');
const porta = Number(process.env.PORT || 3000);
const base = `http://127.0.0.1:${porta}`;
const srv = app.listen(porta, async () => {
  const call = async (j, m, u, b) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', ...(j.c ? { Cookie: j.c } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) j.c = sc.split(';')[0];
    return r.json().catch(() => ({}));
  };
  if (db.prepare('SELECT COUNT(*) n FROM usuarios').get().n === 1) {
    const a = {}; await call(a, 'POST', '/api/login', { email: 'admin@demo.com', senha: 'demo-12345' });
    const lojas = await call(a, 'GET', '/api/lojas');
    const AN = lojas.find((l) => l.nome === 'Anápolis').id, GY = lojas.find((l) => l.nome === 'Goiânia').id;
    for (const [n, e, p, l] of [['Ana (agendamento)', 'agendamento@demo.com', 'colaborador', null], ['Gestor da loja', 'gestor@demo.com', 'gestor_loja', null],
      ['Kátia (KINTO Anápolis)', 'kinto.anapolis1@demo.com', 'kinto', AN], ['Kléber (KINTO Anápolis)', 'kinto.anapolis2@demo.com', 'kinto', AN],
      ['Karina (KINTO Goiânia)', 'kinto.goiania@demo.com', 'kinto', GY]]) await call(a, 'POST', '/api/usuarios', { nome: n, email: e, senha: 'demo-12345', perfil: p, loja_id: l });
    const c = {}; await call(c, 'POST', '/api/login', { email: 'agendamento@demo.com', senha: 'demo-12345' });
    const cfg = await call(c, 'GET', '/api/config'); const mot = (r, d) => cfg.motivos.find((m) => m.resultado === r && m.descricao === d).id;
    const reg = (nome, tel, loja, res, mo) => call(c, 'POST', '/api/contatos', { etapa: 'Agendamento', data_revisao: hoje(), loja_id: loja, cliente_nome: nome, telefone: tel, resultado: res, motivo_id: mot(res, mo) });
    await reg('Paulo Neves', '62 98222-2222', GY, 'Recusou', 'Preço');
    await reg('Tânia Rocha', '62 98222-3333', GY, 'Ainda não decidiu', 'Avalia o preço');
    await reg('Cláudia Reis', '62 98333-1111', AN, 'Não atendeu', 'Caixa postal ou não atendeu');
    await reg('Marcos Pereira', '62 98111-2233', AN, 'Aceitou', 'Conveniência');
  }
  console.log(`
==== DEMONSTRAÇÃO: http://localhost:${porta} ====
Senha de todos: demo-12345
  agendamento@demo.com          Colaborador (só registra; escolhe Anápolis ou Goiânia)
  kinto.anapolis1@demo.com      Consultor KINTO Anápolis
  kinto.anapolis2@demo.com      Consultor KINTO Anápolis (para testar "quem clicar primeiro")
  kinto.goiania@demo.com        Consultor KINTO Goiânia (não deve ver clientes de Anápolis)
  gestor@demo.com               Gestor de loja (painel, fila, casos)
  admin@demo.com                Gestor KINTO (tudo + Administração)
Dica: abra cada perfil em uma janela anônima diferente, lado a lado.
Alerta por e-mail desativado (sem SMTP). Ctrl+C para sair.
`);
});
srv.on('error', (e) => { console.error(e.message); process.exit(1); });
setInterval(() => app.escalar().catch(() => {}), 60000);
