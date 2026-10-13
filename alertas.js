'use strict';
// Escalonamento por e-mail: se um cliente aceitou e ninguém da KINTO assumiu no prazo, avisa a equipe da loja.
const nodemailer = require('nodemailer');
const { db, nowBR, auditar } = require('./db');

const ESCALA_MIN = Number(process.env.ESCALONA_MINUTOS || 15);
const DIAS = (process.env.ATENDIMENTO_DIAS || '1,2,3,4,5,6').split(',').map(Number); // 0 = domingo
const INICIO = process.env.ATENDIMENTO_INICIO || '08:00';
const FIM = process.env.ATENDIMENTO_FIM || '18:00';

function transporte() {
  const url = process.env.SMTP_URL;
  if (!url) return null;
  if (url === 'json') return nodemailer.createTransport({ jsonTransport: true }); // modo de teste: não envia nada
  return nodemailer.createTransport(url);
}

const paraData = (s) => new Date(s.replace(' ', 'T') + 'Z'); // ambos os lados em horário de Brasília, sem fuso
const minutosAtras = (s, n) => new Date(paraData(s).getTime() - n * 60000).toISOString().slice(0, 19).replace('T', ' ');
const minutosEntre = (a, b) => Math.round((paraData(b) - paraData(a)) / 60000);

function emHorario(agora) {
  const dow = new Date(agora.slice(0, 10) + 'T12:00:00Z').getUTCDay();
  const hm = agora.slice(11, 16);
  return DIAS.includes(dow) && hm >= INICIO && hm < FIM;
}

async function escalar(agora = nowBR(), tr = transporte()) {
  if (!emHorario(agora)) return { enviados: [], semConfiguracao: 0 };
  const limite = minutosAtras(agora, ESCALA_MIN);
  const linhas = db.prepare(`SELECT c.id, c.cliente_nome, c.data_revisao, l.nome AS loja, l.email_alerta,
      (SELECT MIN(x.criado_em) FROM contatos x WHERE x.caso_id = c.id AND x.ativo = 1 AND x.resultado IN ('Aceitou','Ainda não decidiu')) AS aceito_em,
      (SELECT 1 FROM contatos x WHERE x.caso_id = c.id AND x.ativo = 1 AND x.resultado = 'Aceitou') AS aceitou
    FROM casos c JOIN lojas l ON l.id = c.loja_id
    LEFT JOIN atendimentos a ON a.caso_id = c.id LEFT JOIN reservas r ON r.caso_id = c.id
    WHERE c.escalado_em IS NULL AND a.id IS NULL AND r.id IS NULL
      AND (EXISTS (SELECT 1 FROM contatos x WHERE x.caso_id = c.id AND x.ativo = 1 AND x.resultado = 'Aceitou')
        OR (SELECT x.resultado FROM contatos x WHERE x.caso_id = c.id AND x.ativo = 1 ORDER BY x.id DESC LIMIT 1) = 'Ainda não decidiu')`).all()
    .filter((r) => r.aceito_em && r.aceito_em <= limite);
  const enviados = []; let semConfiguracao = 0;
  for (const r of linhas) {
    const para = r.email_alerta || process.env.ALERTA_EMAIL_PADRAO;
    if (!tr || !para) { semConfiguracao++; continue; }
    const espera = minutosEntre(r.aceito_em, agora);
    const texto = [
      `Há ${espera} minutos um cliente ${r.aceitou ? 'aceitou o KINTO Share' : 'ficou de decidir sobre o KINTO Share e precisa de contato'} e ninguém assumiu o atendimento.`,
      `Cliente: ${r.cliente_nome}`, `Loja: ${r.loja}`,
      `Revisão em: ${r.data_revisao.slice(8)}/${r.data_revisao.slice(5, 7)}/${r.data_revisao.slice(0, 4)}`,
      '', `Abra o sistema para assumir o atendimento${process.env.APP_URL ? ': ' + process.env.APP_URL : '.'}`,
    ].join('\n'); // sem telefone: os dados de contato ficam só dentro do sistema
    try {
      const info = await tr.sendMail({ from: process.env.SMTP_FROM || 'revisao-premium@localhost', to: para, subject: `Cliente aguardando atendimento KINTO Share: ${r.cliente_nome} (${r.loja})`, text: texto });
      db.prepare('UPDATE casos SET escalado_em = ? WHERE id = ?').run(agora, r.id);
      auditar(null, 'caso', r.id, 'escalonamento', null, { para, espera_min: espera });
      enviados.push({ caso_id: r.id, para, mensagem: info && info.message });
    } catch (e) { console.error('Falha ao enviar e-mail de escalonamento:', e.message); }
  }
  return { enviados, semConfiguracao };
}

module.exports = { escalar, emHorario, minutosEntre, minutosAtras, ESCALA_MIN };
