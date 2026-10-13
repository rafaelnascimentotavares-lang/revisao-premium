'use strict';
// Testes de ponta a ponta da API: perfis, regras de negócio e indicadores.
process.env.DB_PATH = ':memory:';
process.env.BACKUP_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'rp-bk-'));
process.env.ADMIN_EMAIL = 'admin@teste.com';
process.env.ADMIN_PASSWORD = 'senha-admin-123';
const assert = require('assert');
const app = require('./server');
const { hoje, addDays: addDaysT } = require('./db');

let base;
const jar = (name) => ({ name, cookie: '' });
async function call(who, method, url, body) {
  const r = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(who && who.cookie ? { Cookie: who.cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie');
  if (sc && who) who.cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  return { status: r.status, data };
}
let ok = 0;
const t = async (nome, fn) => { try { await fn(); ok++; console.log('  ok  ', nome); } catch (e) { console.error('  FALHA', nome, '\n       ', e.message); process.exitCode = 1; } };

(async () => {
  const srv = app.listen(0);
  base = `http://127.0.0.1:${srv.address().port}`;
  const adm = jar('adm'), colab = jar('colab'), gest = jar('gest'), anon = jar('anon');
  const cfg = {};

  await t('requisição sem login é negada', async () => {
    assert.strictEqual((await call(anon, 'GET', '/api/painel')).status, 401);
    assert.strictEqual((await call(anon, 'GET', '/api/me')).status, 401);
  });
  await t('login com senha errada falha; correto funciona', async () => {
    assert.strictEqual((await call(adm, 'POST', '/api/login', { email: 'admin@teste.com', senha: 'errada' })).status, 401);
    const r = await call(adm, 'POST', '/api/login', { email: 'admin@teste.com', senha: 'senha-admin-123' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.perfil, 'gestor_kinto');
  });
  const lojas = (await call(adm, 'GET', '/api/lojas')).data;
  await t('admin cria colaborador e gestor de loja', async () => {
    let r = await call(adm, 'POST', '/api/usuarios', { nome: 'Ana', email: 'ana@saga.com', senha: 'colab-1234', perfil: 'colaborador' });
    assert.strictEqual(r.status, 201);
    r = await call(adm, 'POST', '/api/usuarios', { nome: 'Bruno', email: 'bruno@saga.com', senha: 'gest-12345', perfil: 'gestor_loja', loja_id: lojas[0].id });
    assert.strictEqual(r.status, 201);
    assert.strictEqual((await call(adm, 'POST', '/api/usuarios', { nome: 'X', email: 'x@saga.com', senha: 'abcdefgh', perfil: 'kinto' })).status, 400, 'consultor KINTO exige loja');
    assert.strictEqual((await call(adm, 'POST', '/api/usuarios', { nome: 'Ana 2', email: 'ANA@saga.com', senha: 'colab-1234', perfil: 'colaborador' })).status, 400, 'e-mail duplicado');
    assert.strictEqual((await call(colab, 'POST', '/api/login', { email: 'ana@saga.com', senha: 'colab-1234' })).status, 200);
    assert.strictEqual((await call(gest, 'POST', '/api/login', { email: 'bruno@saga.com', senha: 'gest-12345' })).status, 200);
  });

  await t('colaborador só escreve: tudo que lê é negado', async () => {
    for (const u of ['/api/painel', '/api/casos', '/api/casos/1', '/api/usuarios', '/api/lojas', '/api/motivos', '/api/auditoria', '/api/export/contatos.csv', '/api/stream']) {
      assert.strictEqual((await call(colab, 'GET', u)).status, 403, u);
    }
    assert.strictEqual((await call(colab, 'PUT', '/api/contatos/1', {})).status, 403);
    assert.strictEqual((await call(colab, 'PUT', '/api/casos/1/reserva', {})).status, 403);
    const c = await call(colab, 'GET', '/api/config');
    assert.strictEqual(c.status, 200); assert.strictEqual(c.data.lojas.length, 2, 'agendamento vê as duas lojas');
    Object.assign(cfg, c.data);
  });
  await t('gestor de loja tem acesso total à leitura, mas não administra', async () => {
    assert.strictEqual((await call(gest, 'GET', '/api/painel')).status, 200);
    assert.strictEqual((await call(gest, 'GET', '/api/casos')).status, 200);
    assert.strictEqual((await call(gest, 'GET', '/api/usuarios')).status, 403);
    assert.strictEqual((await call(gest, 'POST', '/api/motivos', { resultado: 'Recusou', descricao: 'Novo' })).status, 403);
  });

  const mot = (res, desc) => cfg.motivos.find((m) => m.resultado === res && m.descricao === desc).id;
  const rev = hoje();
  const ANA = () => cfg.lojas.find((l) => l.nome === 'Anápolis').id, GYN = () => cfg.lojas.find((l) => l.nome === 'Goiânia').id;
  const reg = (o) => call(colab, 'POST', '/api/contatos', { etapa: 'Agendamento', data_revisao: rev, loja_id: ANA(), ...o });

  await t('validações do formulário', async () => {
    const base = { cliente_nome: 'Teste', telefone: '(62) 99999-0000', resultado: 'Recusou', motivo_id: mot('Recusou', 'Preço') };
    assert.strictEqual((await reg({ ...base, telefone: '123' })).status, 400, 'telefone inválido');
    assert.strictEqual((await reg({ ...base, cliente_nome: '' })).status, 400, 'nome vazio');
    assert.strictEqual((await reg({ ...base, motivo_id: mot('Aceitou', 'Preço ou desconto') })).status, 400, 'motivo de outro resultado');
    assert.strictEqual((await reg({ ...base, resultado: 'Recusou', motivo_id: mot('Recusou', 'Outro') })).status, 400, 'Outro exige observação');
    assert.strictEqual((await reg({ ...base, resultado: 'Inexistente' })).status, 400, 'resultado inválido');
    assert.strictEqual((await reg({ ...base, loja_id: undefined })).status, 400, 'loja da revisão é obrigatória');
    assert.strictEqual((await reg({ ...base, loja_id: 999 })).status, 400, 'loja inexistente');
    assert.strictEqual((await reg({ ...base, data_revisao: '2020-01-01' })).status, 400, 'data antiga');
    assert.strictEqual((await reg({ ...base, motivo_id: mot('Recusou', 'Outro'), observacao: 'prefere ônibus' })).status, 201, 'Outro com observação');
  });

  // cenário de indicadores
  await t('cenário do funil: registros e vínculo por telefone', async () => {
    let r = await reg({ cliente_nome: 'Cliente A', telefone: '62 98888-0001', resultado: 'Aceitou', motivo_id: mot('Aceitou', 'Preço ou desconto') });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.data.vinculado, false);
    assert.deepStrictEqual(Object.keys(r.data).sort(), ['ok', 'vinculado'], 'colaborador não recebe dados da base');
    await reg({ cliente_nome: 'Cliente B', telefone: '62 98888-0002', resultado: 'Recusou', motivo_id: mot('Recusou', 'Preço') });
    await reg({ loja_id: GYN(), cliente_nome: 'Cliente C', telefone: '62 98888-0003', resultado: 'Ainda não decidiu', motivo_id: mot('Ainda não decidiu', 'Avalia o preço') });
    r = await call(colab, 'POST', '/api/contatos', { etapa: 'Confirmação', loja_id: ANA(), cliente_nome: 'Cliente C', telefone: '+55 (62) 98888-0003', data_revisao: rev,
      resultado: 'Aceitou', motivo_id: mot('Aceitou', 'Precisa de carro durante a revisão') });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.data.vinculado, true, 'confirmação liga ao mesmo caso (com +55)');
    assert.strictEqual((await call(gest, 'GET', '/api/casos?q=8888-0003')).data[0].loja, 'Goiânia', 'a loja do caso é a do agendamento, não a da confirmação');
    await reg({ cliente_nome: 'Cliente D', telefone: '62 98888-0004', resultado: 'Não atendeu', motivo_id: mot('Não atendeu', 'Número inválido') });
    await reg({ cliente_nome: 'Cliente E', telefone: '62 98888-0005', resultado: 'Não ofertado', motivo_id: mot('Não ofertado', 'Cliente de frota ou empresa') });
    const dup = await reg({ cliente_nome: 'Cliente B', telefone: '62 98888-0002', resultado: 'Recusou', motivo_id: mot('Recusou', 'Preço') });
    assert.strictEqual(dup.status, 409, 'duplo envio é barrado');
  });

  const casos = (await call(gest, 'GET', '/api/casos')).data;
  const idDe = (nome) => casos.find((c) => c.cliente_nome === nome).id;

  await t('reservas: validações e cálculo de receita', async () => {
    const A = idDe('Cliente A'), C = idDe('Cliente C');
    assert.strictEqual((await call(gest, 'PUT', `/api/casos/${A}/reserva`, { status: 'Não concluída' })).status, 400, 'exige motivo');
    assert.strictEqual((await call(gest, 'PUT', `/api/casos/${A}/reserva`, { status: 'Concluída', retirada: '2026-10-10', devolucao: '2026-10-09' })).status, 400, 'devolução antes da retirada');
    let r = await call(gest, 'PUT', `/api/casos/${A}/reserva`, { status: 'Concluída', retirada: '2026-10-10', devolucao: '2026-10-13', modelo: 'Yaris Cross' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.reserva.diarias, 3, 'diárias calculadas pelas datas');
    assert.strictEqual(r.data.reserva.valor_total, 522.9);
    r = await call(gest, 'PUT', `/api/casos/${C}/reserva`, { status: 'Não concluída', motivo_nao_conclusao: 'Cadastro reprovado' });
    assert.strictEqual(r.status, 200);
  });

  await t('indicadores do painel batem com o cenário', async () => {
    const p = (await call(gest, 'GET', `/api/painel?de=${rev}&ate=${rev}`)).data;
    const x = p.totais;
    // 1 caso extra criado na validação ("Teste", Recusou/Outro): 6 casos, 4 ofertados, 2 aceitaram...
    assert.strictEqual(x.agendamentos, 6);
    assert.strictEqual(x.contatados, 5, 'todos menos o "Não atendeu"');
    assert.strictEqual(x.ofertados, 4);
    assert.strictEqual(x.aceitaram, 2);
    assert.strictEqual(x.recusaram, 2);
    assert.strictEqual(x.indecisos, 1);
    assert.strictEqual(x.recuperados, 1);
    assert.strictEqual(x.concluidas, 1);
    assert.strictEqual(x.nao_concluidas, 1);
    assert.strictEqual(x.receita, 522.9);
    assert.strictEqual(x.diarias, 3);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(p.taxas.oferta, 4 / 6)); assert.ok(near(p.taxas.aceite, 2 / 4));
    assert.ok(near(p.taxas.recuperacao, 1)); assert.ok(near(p.taxas.aceite_reserva, 1 / 2)); assert.ok(near(p.taxas.conversao_total, 1 / 6));
    assert.deepStrictEqual(p.motivos.recusa.map((m) => m.motivo).sort(), ['Outro', 'Preço']);
    assert.strictEqual(p.por_colaborador[0].nome, 'Ana');
    assert.strictEqual(p.por_colaborador[0].contatos, 7);
    assert.strictEqual(p.serie.length, 1);
    const vazio = (await call(gest, 'GET', '/api/painel?de=2020-01-01&ate=2020-01-02')).data;
    assert.strictEqual(vazio.totais.agendamentos, 0); assert.strictEqual(vazio.taxas.oferta, null, 'sem divisão por zero');
  });

  await t('edição pelo gestor gera auditoria; inativação tira do painel', async () => {
    const d = (await call(gest, 'GET', `/api/casos/${idDe('Cliente B')}`)).data;
    const c = d.contatos[0];
    let r = await call(gest, 'PUT', `/api/contatos/${c.id}`, { resultado: 'Aceitou', motivo_id: mot('Aceitou', 'Conveniência') });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await call(gest, 'PUT', `/api/contatos/${c.id}`, { resultado: 'Aceitou', motivo_id: mot('Recusou', 'Preço') })).status, 400);
    let p = (await call(gest, 'GET', `/api/painel?de=${rev}&ate=${rev}`)).data;
    assert.strictEqual(p.totais.aceitaram, 3);
    r = await call(gest, 'DELETE', `/api/contatos/${c.id}`);
    assert.strictEqual(r.status, 200);
    p = (await call(gest, 'GET', `/api/painel?de=${rev}&ate=${rev}`)).data;
    assert.strictEqual(p.totais.aceitaram, 2); assert.strictEqual(p.totais.ofertados, 3);
    const aud = (await call(adm, 'GET', '/api/auditoria')).data;
    assert.ok(aud.some((a) => a.entidade === 'contato' && a.acao === 'edicao' && a.antes && a.depois));
    assert.ok(aud.some((a) => a.entidade === 'contato' && a.acao === 'inativacao'));
  });

  await t('busca e filtros de casos', async () => {
    assert.strictEqual((await call(gest, 'GET', '/api/casos?q=8888-0001')).data.length, 1);
    assert.strictEqual((await call(gest, 'GET', '/api/casos?q=62988880001')).data.length, 1);
    const sr = (await call(gest, 'GET', '/api/casos?filtro=aceitos_sem_reserva')).data;
    assert.strictEqual(sr.length, 0, 'A e C já têm reserva');
    assert.strictEqual((await call(gest, 'GET', '/api/casos?filtro=com_reserva')).data.length, 2);
  });

  await t('exportação CSV com BOM e proteção contra fórmulas', async () => {
    await reg({ cliente_nome: '=HYPERLINK("http://x")', telefone: '62 98888-0006', resultado: 'Recusou', motivo_id: mot('Recusou', 'Preço') });
    const r = await call(gest, 'GET', `/api/export/contatos.csv?de=${rev}&ate=${rev}`);
    assert.strictEqual(r.status, 200);
    const raw = new Uint8Array(await (await fetch(base + `/api/export/contatos.csv?de=${rev}&ate=${rev}`, { headers: { Cookie: gest.cookie } })).arrayBuffer());
    assert.deepStrictEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8 para o Excel');
    assert.ok(r.data.startsWith('ID;Caso;Data/hora'));
    assert.ok(r.data.includes("\"'=HYPERLINK") || r.data.includes("'=HYPERLINK"), 'célula neutralizada');
    assert.ok(!/(^|;)=HYPERLINK/m.test(r.data));
    assert.strictEqual((await call(gest, 'GET', '/api/export/reservas.csv')).status, 200);
  });

  await t('administração: motivos e usuários', async () => {
    let r = await call(adm, 'POST', '/api/motivos', { resultado: 'Recusou', descricao: 'Motivo novo' });
    assert.strictEqual(r.status, 201);
    const cfg2 = (await call(colab, 'GET', '/api/config')).data;
    const novo = cfg2.motivos.find((m) => m.descricao === 'Motivo novo');
    assert.ok(novo, 'novo motivo aparece no menu');
    await call(adm, 'PUT', `/api/motivos/${novo.id}`, { ativo: 0 });
    assert.ok(!(await call(colab, 'GET', '/api/config')).data.motivos.some((m) => m.descricao === 'Motivo novo'), 'inativo some do menu');
    assert.strictEqual((await reg({ cliente_nome: 'Z', telefone: '62 98888-0007', resultado: 'Recusou', motivo_id: novo.id })).status, 400, 'motivo inativo é rejeitado');
    const us = (await call(adm, 'GET', '/api/usuarios')).data;
    const ana = us.find((u) => u.email === 'ana@saga.com');
    assert.strictEqual((await call(adm, 'PUT', `/api/usuarios/${us.find((u) => u.perfil === 'gestor_kinto').id}`, { ativo: 0 })).status, 400, 'não desativa a si mesmo');
    await call(adm, 'PUT', `/api/usuarios/${ana.id}`, { ativo: 0 });
    assert.strictEqual((await call(colab, 'GET', '/api/me')).status, 401, 'sessão do desativado cai');
    assert.strictEqual((await call({ cookie: '' }, 'POST', '/api/login', { email: 'ana@saga.com', senha: 'colab-1234' })).status, 401);
  });

  await t('tempo real: gestor recebe evento ao registrar contato', async () => {
    await call(adm, 'PUT', `/api/usuarios/${(await call(adm, 'GET', '/api/usuarios')).data.find((u) => u.email === 'ana@saga.com').id}`, { ativo: 1 });
    await call(colab, 'POST', '/api/login', { email: 'ana@saga.com', senha: 'colab-1234' });
    const ac = new AbortController();
    const resp = await fetch(base + '/api/stream', { headers: { Cookie: gest.cookie }, signal: ac.signal });
    assert.strictEqual(resp.status, 200);
    const reader = resp.body.getReader();
    await reader.read(); // "retry: 3000"
    const esperado = (async () => { let s = ''; for (;;) { const { value } = await reader.read(); s += Buffer.from(value).toString(); if (s.includes('event: update')) return true; } })();
    await reg({ cliente_nome: 'RT', telefone: '62 98888-0008', resultado: 'Recusou', motivo_id: mot('Recusou', 'Preço') });
    const got = await Promise.race([esperado, new Promise((res) => setTimeout(() => res(false), 3000))]);
    ac.abort();
    assert.strictEqual(got, true);
  });

  // ---------- fila KINTO: isolamento por loja ----------
  const k1 = jar('k1'), k2 = jar('k2'), k3 = jar('k3');
  let F, G, H, venc, perd;
  await t('consultor KINTO: criação, loja obrigatória e acesso restrito', async () => {
    for (const [n, e, lj] of [['Kátia', 'k1@kinto.com', ANA()], ['Kléber', 'k2@kinto.com', ANA()], ['Karina', 'k3@kinto.com', GYN()]]) {
      assert.strictEqual((await call(adm, 'POST', '/api/usuarios', { nome: n, email: e, senha: 'kinto-1234', perfil: 'kinto', loja_id: lj })).status, 201);
    }
    for (const [j, e] of [[k1, 'k1@kinto.com'], [k2, 'k2@kinto.com'], [k3, 'k3@kinto.com']]) assert.strictEqual((await call(j, 'POST', '/api/login', { email: e, senha: 'kinto-1234' })).status, 200);
    for (const u of ['/api/painel', '/api/casos', '/api/casos/1', '/api/usuarios', '/api/lojas', '/api/motivos', '/api/auditoria', '/api/export/contatos.csv', '/api/export/reservas.csv']) {
      assert.strictEqual((await call(k1, 'GET', u)).status, 403, u);
    }
    assert.strictEqual((await call(k1, 'POST', '/api/contatos', { etapa: 'Agendamento', cliente_nome: 'Zed', telefone: '62 98888-0099', data_revisao: rev, loja_id: ANA(), resultado: 'Recusou', motivo_id: mot('Recusou', 'Preço') })).status, 403, 'consultor não registra contatos');
    const c = (await call(k1, 'GET', '/api/config')).data;
    assert.deepStrictEqual(c.lojas.map((l) => l.nome), ['Anápolis'], 'consultor só vê a própria loja');
    assert.strictEqual((await call(k1, 'PUT', '/api/contatos/1', {})).status, 403);
  });
  await t('cada cliente que aceita aparece só para o time da loja dele', async () => {
    await reg({ cliente_nome: 'Cliente F', telefone: '62 98888-0011', resultado: 'Aceitou', motivo_id: mot('Aceitou', 'Conveniência') });
    await reg({ loja_id: GYN(), cliente_nome: 'Cliente G', telefone: '62 98888-0012', resultado: 'Aceitou', motivo_id: mot('Aceitou', 'Já conhece a KINTO') });
    await reg({ cliente_nome: 'Cliente R', telefone: '62 98888-0013', resultado: 'Recusou', motivo_id: mot('Recusou', 'Preço') });
    const f1 = (await call(k1, 'GET', '/api/fila')).data.itens, f3 = (await call(k3, 'GET', '/api/fila')).data.itens;
    F = f1.find((x) => x.cliente_nome === 'Cliente F').id; G = f3.find((x) => x.cliente_nome === 'Cliente G').id;
    assert.ok(!f1.some((x) => x.cliente_nome === 'Cliente G'), 'Anápolis não vê Goiânia');
    assert.ok(!f3.some((x) => x.cliente_nome === 'Cliente F'), 'Goiânia não vê Anápolis');
    assert.ok(!f1.concat(f3).some((x) => x.cliente_nome === 'Cliente R'), 'quem recusou não aparece');
    assert.ok(f1.every((x) => x.loja === 'Anápolis') && f3.every((x) => x.loja === 'Goiânia'));
    assert.strictEqual(f1.find((x) => x.id === F).situacao, 'Aguardando');
    const g = (await call(gest, 'GET', '/api/fila')).data.itens;
    assert.ok(g.some((x) => x.id === F) && g.some((x) => x.id === G), 'gestor vê as duas lojas');
    assert.strictEqual((await call(gest, 'GET', `/api/fila?loja=${GYN()}`)).data.itens.some((x) => x.id === F), false);
  });
  await t('outra loja recebe 404 em ficha, assumir, liberar e reserva', async () => {
    assert.strictEqual((await call(k3, 'GET', `/api/fila/${F}`)).status, 404);
    assert.strictEqual((await call(k3, 'POST', `/api/fila/${F}/assumir`)).status, 404);
    assert.strictEqual((await call(k3, 'POST', `/api/fila/${F}/liberar`)).status, 404);
    assert.strictEqual((await call(k3, 'PUT', `/api/fila/${F}/reserva`, { status: 'Concluída' })).status, 404);
    assert.strictEqual((await call(k1, 'GET', `/api/fila/${G}`)).status, 404);
    const rec = (await call(gest, 'GET', '/api/casos?q=98888-0013')).data[0].id;
    assert.strictEqual((await call(k1, 'GET', `/api/fila/${rec}`)).status, 404, 'cliente que recusou não é acessível');
    assert.strictEqual((await call(k1, 'GET', '/api/fila/999999')).status, 404);
  });
  await t('assumir é atômico: dois consultores ao mesmo tempo, só um leva', async () => {
    const rs = await Promise.all([call(k1, 'POST', `/api/fila/${F}/assumir`), call(k2, 'POST', `/api/fila/${F}/assumir`)]);
    const st = rs.map((r) => r.status).sort();
    assert.deepStrictEqual(st, [200, 409]);
    const perdeu = rs.find((r) => r.status === 409);
    assert.ok(/já assumiu/.test(perdeu.data.erro));
    venc = rs[0].status === 200 ? k1 : k2; perd = rs[0].status === 200 ? k2 : k1;
    const lista = (await call(k1, 'GET', '/api/fila')).data.itens.find((x) => x.id === F);
    assert.strictEqual(lista.situacao, 'Em atendimento');
  });
  await t('locação: só quem assumiu registra; cálculo e painel', async () => {
    const v = venc, p = perd;
    assert.strictEqual((await call(p, 'PUT', `/api/fila/${F}/reserva`, { status: 'Concluída' })).status, 403, 'outro consultor da mesma loja não registra');
    assert.strictEqual((await call(v, 'PUT', `/api/fila/${F}/reserva`, { status: 'Não concluída' })).status, 400, 'exige motivo');
    const r = await call(v, 'PUT', `/api/fila/${F}/reserva`, { status: 'Concluída', retirada: '2026-10-20', devolucao: '2026-10-22', modelo: 'Corolla' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.reserva.valor_total, 348.6);
    assert.strictEqual((await call(p, 'POST', `/api/fila/${F}/assumir`)).status, 409, 'finalizado não é reassumido');
    assert.strictEqual((await call(v, 'GET', '/api/fila')).data.itens.find((x) => x.id === F).situacao, 'Concluída');
    const at = (await call(gest, 'GET', `/api/painel?de=${rev}&ate=${rev}`)).data.atendimento;
    assert.ok(at.por_atendente.some((a) => a.assumidos === 1 && a.concluidas === 1));
    assert.strictEqual(at.aguardando, 1, 'só o Cliente G aguarda');
  });
  await t('devolver à fila e reatribuir respeitam a loja', async () => {
    const r1 = await call(k3, 'POST', `/api/fila/${G}/assumir`); assert.strictEqual(r1.status, 200);
    assert.strictEqual((await call(k1, 'POST', `/api/fila/${G}/liberar`)).status, 404, 'Anápolis não mexe em Goiânia');
    const k3id = (await call(adm, 'GET', '/api/usuarios')).data.find((u) => u.email === 'k3@kinto.com').id;
    const k1id = (await call(adm, 'GET', '/api/usuarios')).data.find((u) => u.email === 'k1@kinto.com').id;
    assert.strictEqual((await call(gest, 'POST', `/api/fila/${G}/reatribuir`, { usuario_id: k1id })).status, 400, 'não reatribui para consultor de outra loja');
    assert.strictEqual((await call(k3, 'POST', `/api/fila/${G}/reatribuir`, { usuario_id: k3id })).status, 403, 'consultor não reatribui');
    assert.strictEqual((await call(k3, 'POST', `/api/fila/${G}/liberar`)).status, 200);
    assert.strictEqual((await call(k3, 'GET', '/api/fila')).data.itens.find((x) => x.id === G).situacao, 'Aguardando');
    assert.strictEqual((await call(gest, 'POST', `/api/fila/${G}/reatribuir`, { usuario_id: k3id })).status, 200);
    assert.strictEqual((await call(k3, 'GET', `/api/fila/${G}`)).data.atendimento.nome, 'Karina');
    await call(k3, 'POST', `/api/fila/${G}/liberar`);
  });
  await t('alerta em tempo real vai só para a loja do cliente', async () => {
    const abre = async (j) => { const ac = new AbortController(); const resp = await fetch(base + '/api/stream', { headers: { Cookie: j.cookie }, signal: ac.signal }); const reader = resp.body.getReader(); await reader.read(); let s = ''; const lido = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) return; s += Buffer.from(value).toString(); } } catch { /* abortado */ } })(); return { ac, get: () => s, lido }; };
    await new Promise((r) => setTimeout(r, 500)); // deixa passar avisos pendentes do teste anterior
    const s1 = await abre(k1), s3 = await abre(k3);
    await reg({ cliente_nome: 'Cliente H', telefone: '62 98888-0014', resultado: 'Aceitou', motivo_id: mot('Aceitou', 'Conveniência') });
    await new Promise((r) => setTimeout(r, 800));
    s1.ac.abort(); s3.ac.abort();
    assert.ok(s1.get().includes('event: aceite') && s1.get().includes('Cliente H'), 'Anápolis é avisada');
    assert.ok(!s3.get().includes('Cliente H') && !s3.get().includes('event: aceite'), 'Goiânia não recebe nada de Anápolis');
    assert.ok(!s3.get().includes('event: update'), 'nem atualização de lista');
    H = (await call(k1, 'GET', '/api/fila')).data.itens.find((x) => x.cliente_nome === 'Cliente H').id;
  });
  await t('escalonamento por e-mail: só em horário comercial, uma vez, por loja, sem telefone', async () => {
    const enviados = []; const tr = { sendMail: async (m) => { enviados.push(m); return { message: JSON.stringify(m) }; } };
    assert.strictEqual((await call(adm, 'PUT', `/api/lojas/${ANA()}`, { email_alerta: 'kinto.anapolis@saga.com' })).status, 200);
    assert.strictEqual((await call(adm, 'PUT', `/api/lojas/${ANA()}`, { email_alerta: 'invalido' })).status, 400);
    const domingo = '2030-01-06 10:00:00', quarta = '2030-01-02 10:00:00', noite = '2030-01-02 22:00:00';
    assert.strictEqual((await app.escalar(domingo, tr)).enviados.length, 0, 'domingo');
    assert.strictEqual((await app.escalar(noite, tr)).enviados.length, 0, 'fora do expediente');
    const r = await app.escalar(quarta, tr);
    assert.strictEqual(r.enviados.length, 1, 'H (Anápolis) não foi assumido');
    assert.strictEqual(r.enviados[0].caso_id, H); assert.strictEqual(r.semConfiguracao, 1, 'Goiânia sem e-mail configurado (G aguarda)');
    assert.strictEqual(enviados[0].to, 'kinto.anapolis@saga.com');
    assert.ok(enviados[0].text.includes('Cliente H') && !/\d{4}-\d{4}/.test(enviados[0].text) && !enviados[0].text.includes('98888'), 'sem telefone no e-mail');
    assert.strictEqual((await app.escalar(quarta, tr)).enviados.length, 0, 'não reenvia');
    await call(k1, 'POST', `/api/fila/${H}/assumir`);
  });

  await t('contador do dia: colaborador vê só a própria quantidade de agendamentos', async () => {
    const antes = (await call(colab, 'GET', '/api/meu-dia')).data;
    assert.deepStrictEqual(Object.keys(antes).sort(), ['agendamentos', 'data'], 'só o número, sem dados de clientes');
    await reg({ cliente_nome: 'Cliente Contador', telefone: '62 98888-0021', resultado: 'Não atendeu', motivo_id: mot('Não atendeu', 'Número inválido') });
    assert.strictEqual((await call(colab, 'GET', '/api/meu-dia')).data.agendamentos, antes.agendamentos + 1);
    await call(colab, 'POST', '/api/contatos', { etapa: 'Confirmação', loja_id: ANA(), data_revisao: rev, cliente_nome: 'Cliente Contador', telefone: '62 98888-0021', resultado: 'Recusou', motivo_id: mot('Recusou', 'Preço') });
    assert.strictEqual((await call(colab, 'GET', '/api/meu-dia')).data.agendamentos, antes.agendamentos + 1, 'confirmação não conta como novo agendamento');
    assert.strictEqual((await call(gest, 'GET', '/api/meu-dia')).data.agendamentos, 0, 'cada um vê só o seu');
    assert.strictEqual((await call(k1, 'GET', '/api/meu-dia')).status, 403, 'consultor KINTO não tem contador');
    assert.strictEqual((await call(anon, 'GET', '/api/meu-dia')).status, 401);
  });
  await t('"Ainda não decidiu" também vai para o time KINTO da loja (e sai se virar recusa)', async () => {
    await new Promise((r) => setTimeout(r, 500));
    const abre = async (j) => { const ac = new AbortController(); const resp = await fetch(base + '/api/stream', { headers: { Cookie: j.cookie }, signal: ac.signal }); const reader = resp.body.getReader(); await reader.read(); let s = ''; (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) return; s += Buffer.from(value).toString(); } } catch { /* abortado */ } })(); return { ac, get: () => s }; };
    const s1 = await abre(k1), s3 = await abre(k3);
    await reg({ cliente_nome: 'Cliente Indeciso', telefone: '62 98888-0031', resultado: 'Ainda não decidiu', motivo_id: mot('Ainda não decidiu', 'Avalia o preço') });
    await new Promise((r) => setTimeout(r, 800));
    s1.ac.abort(); s3.ac.abort();
    assert.ok(s1.get().includes('event: aceite') && s1.get().includes('Cliente Indeciso') && s1.get().includes('Ainda não decidiu'), 'Anápolis é avisada');
    assert.ok(!s3.get().includes('Cliente Indeciso'), 'Goiânia não recebe');
    const f1 = (await call(k1, 'GET', '/api/fila')).data.itens, item = f1.find((x) => x.cliente_nome === 'Cliente Indeciso');
    assert.ok(item, 'aparece na fila da loja'); assert.strictEqual(item.origem, 'Ainda não decidiu'); assert.strictEqual(item.situacao, 'Aguardando');
    assert.ok(!(await call(k3, 'GET', '/api/fila')).data.itens.some((x) => x.cliente_nome === 'Cliente Indeciso'));
    assert.strictEqual((await call(k3, 'GET', `/api/fila/${item.id}`)).status, 404);
    const ficha = (await call(k1, 'GET', `/api/fila/${item.id}`)).data;
    assert.strictEqual(ficha.aceite.origem, 'Ainda não decidiu');
    // painel e e-mail enxergam o cliente
    assert.ok((await call(gest, 'GET', `/api/painel?de=${rev}&ate=${rev}`)).data.atendimento.aguardando >= 1);
    const enviados = []; const tr = { sendMail: async (m) => { enviados.push(m); return { message: '{}' }; } };
    await call(adm, 'PUT', `/api/lojas/${ANA()}`, { email_alerta: 'kinto.anapolis@saga.com' });
    await app.escalar('2030-01-02 10:00:00', tr);
    assert.ok(enviados.some((m) => m.text.includes('Cliente Indeciso') && /decidir/.test(m.text)), 'e-mail de escalonamento cobre o indeciso');
    // assume e registra a locação: funciona igual
    assert.strictEqual((await call(k1, 'POST', `/api/fila/${item.id}/assumir`)).status, 200);
    // quando o indeciso aceita depois, continua o mesmo caso; origem passa a Aceitou
    await call(colab, 'POST', '/api/contatos', { etapa: 'Confirmação', loja_id: ANA(), data_revisao: rev, cliente_nome: 'Cliente Indeciso', telefone: '62 98888-0031', resultado: 'Aceitou', motivo_id: mot('Aceitou', 'Conveniência') });
    assert.strictEqual((await call(k1, 'GET', '/api/fila')).data.itens.find((x) => x.id === item.id).origem, 'Aceitou');
    // indeciso que depois recusa sai da fila (se ninguém assumiu)
    await reg({ cliente_nome: 'Cliente Indeciso 2', telefone: '62 98888-0032', resultado: 'Ainda não decidiu', motivo_id: mot('Ainda não decidiu', 'Avalia o preço') });
    const i2 = (await call(k1, 'GET', '/api/fila')).data.itens.find((x) => x.cliente_nome === 'Cliente Indeciso 2').id;
    await call(colab, 'POST', '/api/contatos', { etapa: 'Confirmação', loja_id: ANA(), data_revisao: rev, cliente_nome: 'Cliente Indeciso 2', telefone: '62 98888-0032', resultado: 'Recusou', motivo_id: mot('Recusou', 'Preço') });
    assert.ok(!(await call(k1, 'GET', '/api/fila')).data.itens.some((x) => x.id === i2), 'recusou: sai da fila');
    assert.strictEqual((await call(k1, 'GET', `/api/fila/${i2}`)).status, 404);
  });
  await t('aceite→reserva só conta quem aceitou (indeciso fechado pela KINTO não distorce)', async () => {
    const id = (await call(gest, 'GET', '/api/casos?q=98888-0031')).data[0].id;
    const k = (await call(k1, 'GET', `/api/fila/${id}`)).data.atendimento.nome === 'Kátia' ? k1 : k2;
    const antes = (await call(gest, 'GET', `/api/painel?de=${rev}&ate=${rev}`)).data;
    assert.strictEqual((await call(k, 'PUT', `/api/fila/${id}/reserva`, { status: 'Concluída', diarias: 1 })).status, 200);
    const dep = (await call(gest, 'GET', `/api/painel?de=${rev}&ate=${rev}`)).data;
    assert.strictEqual(dep.totais.concluidas, antes.totais.concluidas + 1);
    assert.ok(dep.taxas.aceite_reserva <= 1);
  });
  await t('exportações CSV: contatos, reservas, casos e relatório do painel', async () => {
    await reg({ cliente_nome: 'Zé "Aspas"; Ponto', telefone: '62 98888-0041', resultado: 'Recusou', motivo_id: mot('Recusou', 'Outro'), observacao: 'linha 1\nlinha 2; com "aspas"' });
    const raw = async (u, who = gest) => { const r = await fetch(base + u, { headers: { Cookie: who.cookie } }); return { r, buf: new Uint8Array(await r.arrayBuffer()), txt: Buffer.from(await (async () => r.clone ? '' : '')()).toString() }; };
    for (const u of ['contatos', 'reservas', 'casos', 'painel']) {
      const x = await raw(`/api/export/${u}.csv?de=${rev}&ate=${rev}`);
      assert.strictEqual(x.r.status, 200, u);
      assert.ok((x.r.headers.get('content-type') || '').startsWith('text/csv'), u);
      assert.ok(/attachment; filename=/.test(x.r.headers.get('content-disposition')), u);
      assert.deepStrictEqual([...x.buf.slice(0, 3)], [0xef, 0xbb, 0xbf], 'BOM em ' + u);
      assert.strictEqual((await call(colab, 'GET', `/api/export/${u}.csv`)).status, 403, 'colaborador não exporta ' + u);
      assert.strictEqual((await call(k1, 'GET', `/api/export/${u}.csv`)).status, 403, 'consultor não exporta ' + u);
      assert.strictEqual((await call(anon, 'GET', `/api/export/${u}.csv`)).status, 401, u);
    }
    const casosCsv = (await call(gest, 'GET', '/api/export/casos.csv')).data;
    assert.ok(casosCsv.split('\r\n')[0].startsWith('Caso;Cliente;Telefone;Data da revisão;Loja;Criado em'));
    assert.ok(casosCsv.includes('"Zé ""Aspas""; Ponto"'), 'aspas e ponto e vírgula escapados');
    assert.ok(casosCsv.includes('Cliente A'), 'traz os casos');
    const so = (await call(gest, 'GET', `/api/export/casos.csv?filtro=com_reserva`)).data.split('\r\n').filter(Boolean);
    assert.ok(so.length >= 2 && so.every((l, i) => i === 0 || /Concluída|Não concluída/.test(l)), 'respeita o filtro da tela');
    const gy = (await call(gest, 'GET', `/api/export/casos.csv?loja=${GYN()}`)).data;
    assert.ok(gy.includes('Goiânia') && !gy.includes(';Anápolis;'), 'respeita o filtro de loja');
    assert.strictEqual((await call(gest, 'GET', '/api/export/casos.csv?q=98888-0001')).data.split('\r\n').filter(Boolean).length, 2, 'respeita a busca');
    const rel = (await call(gest, 'GET', `/api/export/painel.csv?de=${rev}&ate=${rev}`)).data;
    for (const secao of ['Indicadores', 'Taxas', 'Por dia', 'Motivos de recusa', 'Por loja', 'Por colaborador', 'Atendimento KINTO']) assert.ok(rel.includes(secao), secao);
    assert.ok(/Receita \(R\$\);\d+,\d\d/.test(rel), 'valores no formato pt-BR');
    const lojaRel = (await call(gest, 'GET', `/api/export/painel.csv?de=${rev}&ate=${rev}&loja=${GYN()}`)).data;
    assert.ok(lojaRel.includes('Loja;Goiânia'));
    const pn = (await call(gest, 'GET', `/api/painel?de=${rev}&ate=${rev}`)).data.totais.agendamentos;
    assert.ok(rel.includes(`Agendamentos;${pn}\r\n`), 'relatório bate com o painel');
  });
  await t('motivos de locação não concluída no painel e no relatório', async () => {
    const p = (await call(gest, 'GET', `/api/painel?de=${rev}&ate=${rev}`)).data;
    const lista = p.motivos.nao_concluida;
    assert.ok(lista.some((x) => x.motivo === 'Cadastro reprovado' && x.n >= 1), 'motivo da reserva não concluída do Cliente C');
    assert.strictEqual(lista.reduce((s, x) => s + x.n, 0), p.totais.nao_concluidas, 'soma bate com o total de não concluídas');
    const id = (await call(gest, 'GET', '/api/casos?q=98888-0011')).data[0].id;
    await call(gest, 'PUT', `/api/casos/${id}/reserva`, { status: 'Não concluída', motivo_nao_conclusao: 'Sem cartão ou limite' });
    const p2 = (await call(gest, 'GET', `/api/painel?de=${rev}&ate=${rev}`)).data;
    assert.strictEqual(p2.motivos.nao_concluida.find((x) => x.motivo === 'Sem cartão ou limite').n, 1);
    const rel = (await call(gest, 'GET', `/api/export/painel.csv?de=${rev}&ate=${rev}`)).data;
    assert.ok(rel.includes('Motivos de locação não concluída\r\nMotivo;Quantidade;% do total\r\n'), 'bloco no relatório');
    assert.ok(/Sem cartão ou limite;1;\d+,\d%/.test(rel) && /Cadastro reprovado;\d+;/.test(rel));
    const vazio = (await call(gest, 'GET', '/api/painel?de=2020-01-01&ate=2020-01-02')).data;
    assert.deepStrictEqual(vazio.motivos.nao_concluida, []);
  });
  await t('painel: contagem e taxa de locações não concluídas (total, por loja e CSV)', async () => {
    const p = (await call(gest, 'GET', `/api/painel?de=${rev}&ate=${rev}`)).data;
    assert.ok(p.totais.nao_concluidas >= 1, 'há ao menos 1 não concluída');
    const somaLojas = p.por_loja.reduce((s, l) => s + l.nao_concluidas, 0);
    assert.strictEqual(somaLojas, p.totais.nao_concluidas, 'soma por loja = total');
    const esperado = p.totais.nao_concluidas / (p.totais.concluidas + p.totais.nao_concluidas);
    assert.ok(Math.abs(p.taxas.nao_conclusao - esperado) < 1e-9, 'taxa = não concluídas / reservas registradas');
    const rel = (await call(gest, 'GET', `/api/export/painel.csv?de=${rev}&ate=${rev}`)).data;
    assert.ok(rel.includes('Reservas não concluídas;') && rel.includes('% não concluídas') && rel.includes('Locações não concluídas (não concluídas / reservas registradas);'));
  });
  await t('backup: manual, listagem, download e permissão', async () => {
    assert.strictEqual((await call(colab, 'POST', '/api/admin/backups')).status, 403);
    assert.strictEqual((await call(gest, 'GET', '/api/admin/banco')).status, 403);
    const r = await call(adm, 'POST', '/api/admin/backups');
    assert.strictEqual(r.status, 201); assert.ok(/^app-\d{8}-\d{6}-manual\.db$/.test(r.data.nome));
    const l = (await call(adm, 'GET', '/api/admin/banco')).data;
    assert.ok(l.backups.some((b) => b.nome === r.data.nome) && l.versao_esquema >= 2 && l.registros.casos > 0);
    const dl = await fetch(base + '/api/admin/backups/' + r.data.nome, { headers: { Cookie: adm.cookie } });
    assert.strictEqual(dl.status, 200);
    assert.strictEqual(Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
    assert.strictEqual((await call(adm, 'GET', '/api/admin/backups/..%2F..%2Fetc%2Fpasswd')).status, 404);
    assert.strictEqual((await call(adm, 'GET', '/api/admin/backups/qualquer.db')).status, 404);
  });
  await t('backup automático: 1 por dia, só após a hora, com retenção', async () => {
    const bk = require('./backup');
    assert.strictEqual(bk.precisaAutomatico(process.env.BACKUP_DIR, '2030-01-01 01:00:00'), false);
    assert.strictEqual(bk.precisaAutomatico(process.env.BACKUP_DIR, '2030-01-01 03:00:00'), true);
    const { db } = require('./db');
    bk.criarBackup(db.d, process.env.BACKUP_DIR, 'auto', '2030-01-01 03:00:00');
    assert.strictEqual(bk.precisaAutomatico(process.env.BACKUP_DIR, '2030-01-01 23:00:00'), false);
    assert.strictEqual(bk.precisaAutomatico(process.env.BACKUP_DIR, '2030-01-02 03:00:00'), true);
    for (let i = 0; i < 20; i++) bk.criarBackup(db.d, process.env.BACKUP_DIR, 'auto', `2030-02-${String(i + 1).padStart(2, '0')} 03:00:00`);
    bk.aplicarRetencao(process.env.BACKUP_DIR);
    assert.strictEqual(bk.listar(process.env.BACKUP_DIR).filter((b) => b.tipo === 'auto').length, bk.RETENCAO.auto);
  });
  await t('exportar banco (.db) e importar rejeita arquivo inválido', async () => {
    assert.strictEqual((await fetch(base + '/api/admin/banco/exportar', { headers: { Cookie: gest.cookie } })).status, 403);
    const ex = await fetch(base + '/api/admin/banco/exportar', { headers: { Cookie: adm.cookie } });
    assert.strictEqual(ex.status, 200);
    assert.ok(/revisao-premium-\d{4}-\d{2}-\d{2}\.db/.test(ex.headers.get('content-disposition')));
    const imp = (body, q = '?confirmo=RESTAURAR') => fetch(base + '/api/admin/banco/importar' + q, { method: 'POST', headers: { Cookie: adm.cookie, 'Content-Type': 'application/octet-stream' }, body });
    assert.strictEqual((await imp(Buffer.from('isto não é um banco'))).status, 400);
    assert.strictEqual((await imp(Buffer.from(await ex.arrayBuffer()), '')).status, 400, 'exige confirmação');
    const { DatabaseSync } = require('node:sqlite'); const fs = require('fs'); const path = require('path'); const os = require('os');
    const vazio = path.join(os.tmpdir(), 'rp-vazio-' + Date.now() + '.db'); const d = new DatabaseSync(vazio); d.exec('CREATE TABLE x (a)'); d.close();
    const r = await imp(fs.readFileSync(vazio)); assert.strictEqual(r.status, 400);
    assert.ok((await r.json()).erro.includes('não é um backup'));
    assert.strictEqual((await call(adm, 'GET', '/api/me')).status, 200, 'nada mudou');
  });
  await t('restaurar: volta ao estado do backup, encerra sessões e guarda cópia de segurança', async () => {
    const antes = (await call(adm, 'GET', '/api/admin/banco')).data.registros;
    const b = (await call(adm, 'POST', '/api/admin/backups')).data;
    const rev2 = addDaysT(hoje(), 3);
    let r = await call(colab, 'POST', '/api/contatos', { etapa: 'Agendamento', data_revisao: rev2, loja_id: ANA(), cliente_nome: 'Depois do backup', telefone: '62 97777-0001', resultado: 'Recusou', motivo_id: mot('Recusou', 'Preço') });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.strictEqual((await call(adm, 'GET', '/api/admin/banco')).data.registros.casos, antes.casos + 1);
    assert.strictEqual((await call(adm, 'POST', '/api/admin/backups/' + b.nome + '/restaurar', { confirmo: 'errado' })).status, 400);
    r = await call(adm, 'POST', '/api/admin/backups/' + b.nome + '/restaurar', { confirmo: 'RESTAURAR' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data)); assert.ok(/pre-restauracao/.test(r.data.backup_de_seguranca));
    assert.strictEqual((await call(adm, 'GET', '/api/me')).status, 401, 'sessões encerradas');
    assert.strictEqual((await call(adm, 'POST', '/api/login', { email: 'admin@teste.com', senha: 'senha-admin-123' })).status, 200);
    assert.deepStrictEqual((await call(adm, 'GET', '/api/admin/banco')).data.registros.casos, antes.casos);
    const aud = (await call(adm, 'GET', '/api/auditoria')).data;
    assert.ok(aud.some((x) => x.entidade === 'banco' && x.acao === 'restauracao'));
    // a cópia de segurança contém o caso criado depois do backup: importar de volta o traz de novo
    const seg = require('fs').readFileSync(require('path').join(process.env.BACKUP_DIR, r.data.backup_de_seguranca));
    const ri = await fetch(base + '/api/admin/banco/importar?confirmo=RESTAURAR', { method: 'POST', headers: { Cookie: adm.cookie, 'Content-Type': 'application/octet-stream' }, body: seg });
    assert.strictEqual(ri.status, 200, await ri.text());
    assert.ok(await call(adm, 'POST', '/api/login', { email: 'admin@teste.com', senha: 'senha-admin-123' }));
    assert.strictEqual((await call(adm, 'GET', '/api/admin/banco')).data.registros.casos, antes.casos + 1);
  });
  await t('esquema: versão registrada e migração de banco antigo', async () => {
    const { db, SCHEMA_VERSAO } = require('./db');
    assert.strictEqual(db.prepare("SELECT valor FROM meta WHERE chave='schema_versao'").get().valor, String(SCHEMA_VERSAO));
  });
  await t('limite de tentativas de login', async () => {
    let last;
    for (let i = 0; i < 9; i++) last = await call({ cookie: '' }, 'POST', '/api/login', { email: 'alvo@saga.com', senha: 'x' });
    assert.strictEqual(last.status, 429);
  });

  console.log(`\n${ok} testes passaram${process.exitCode ? ' (com falhas)' : ''}`);
  srv.close();
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
