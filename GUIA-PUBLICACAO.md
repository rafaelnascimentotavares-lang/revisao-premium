# Guia de publicação na internet

O sistema é um único servidor Node.js com banco SQLite em arquivo. Para publicar você precisa de: (1) um lugar que rode o servidor 24 h, (2) um **disco persistente** para o banco e (3) HTTPS (a hospedagem entrega). Escolha uma das duas rotas.

> **Regra de ouro:** o banco é um arquivo. Hospedagem sem disco persistente (planos gratuitos, em geral) **apaga os dados** a cada reinício. Use sempre plano com disco/volume.

## Rota A — Render (mais simples, sem mexer em servidor)
1. Crie um repositório **privado** no GitHub e envie o conteúdo desta pasta (sem `node_modules` e sem `data`; o `.gitignore` já cuida disso).
2. Em render.com: **New → Blueprint** → escolha o repositório. Ele lê o `render.yaml` (Docker, plano pago *Starter*, disco de 1 GB em `/data`).
3. Preencha as variáveis pedidas:
   - `ADMIN_EMAIL` e `ADMIN_PASSWORD` (mín. 10 caracteres): criam o primeiro Gestor KINTO. Sem isso o servidor se recusa a subir.
   - `APP_URL`: o endereço final (ex.: `https://revisao-premium.onrender.com`).
   - E-mail de escalonamento (opcional): `SMTP_URL`, `SMTP_FROM`, `ALERTA_EMAIL_PADRAO`.
4. Aguarde o deploy. Domínio próprio (ex.: `revisao.sagatoyota.com.br`): *Settings → Custom Domains* e criar o registro CNAME indicado.
> Confira preços e planos atuais no site da Render antes de contratar.

## Rota B — Servidor próprio (VPS Linux com Docker)
1. Aponte um domínio (registro A) para o IP do servidor e abra as portas 80 e 443.
2. Copie o projeto para o servidor, entre em `deploy/`, copie `.env.example` para `.env` e preencha.
3. `docker compose up -d`. O Caddy obtém e renova o HTTPS sozinho.
4. Atualizar versão: substitua os arquivos e rode `docker compose up -d --build` (os dados ficam no volume `dados`).

## Depois de publicar (checklist)
1. Entre com o administrador e **troque a senha** (botão *Senha*).
2. **Administração → Usuários**: cadastre colaboradores (agendamento), consultores KINTO (cada um com sua loja) e gestores. Use senhas individuais; ninguém compartilha login.
3. **Administração → Lojas**: informe o e-mail de alerta de cada loja.
4. **Administração → Dados e backup**: clique em *Fazer backup agora*, baixe o arquivo e teste *Exportar*. O backup automático roda todo dia às 02:00.
5. Faça um teste completo com 2 usuários: registrar um aceite, ver o aviso na fila da loja certa, assumir e registrar a reserva.
6. Teste no celular: o sistema funciona no navegador (Chrome/Safari); notificações do navegador exigem HTTPS, que a publicação já entrega.

## Atualizações nunca apagam os dados
Os dados (banco e backups) ficam **fora da pasta do programa**. Em produção o padrão é `~/revisao-premium-dados/` (pasta pessoal do usuário no servidor); no Docker/Render, o disco `/data`. Pode escolher outra pasta com `DATA_DIR`.
- **Redeploy/atualização:** a pasta do programa pode ser apagada e recriada à vontade; o banco continua no mesmo lugar e as colunas novas são adicionadas sozinhas, sem apagar nada.
- **Backup automático antes de atualizar:** quando o sistema detecta que o código mudou, cria um backup "antes de atualização" ANTES de usar o banco (aparece em Administração → Dados e backup).
- **Banco antigo dentro da pasta do programa** (versões anteriores): é copiado automaticamente para a pasta de dados na primeira subida.
- **Recuperação automática:** se o banco sumir mas a pasta de backups existir, o sistema restaura o backup mais recente ao iniciar.
- **Na Hostinger:** não defina `DB_PATH` apontando para dentro do projeto. Deixe o padrão ou use `DATA_DIR=/home/SEU-USUARIO/revisao-premium-dados`. Se o log mostrar "ATENÇÃO: Sem permissão em ...", defina `DATA_DIR` para uma pasta onde o usuário possa gravar.
- Nunca use "limpar/zerar" a pasta de dados no painel da hospedagem.

## Segurança já incluída
HTTPS obrigatório (HSTS), cookie de sessão HttpOnly/Secure/SameSite, bloqueio de tentativas de login por IP e por e-mail, verificação de origem em ações de escrita, cabeçalhos de segurança (CSP restrita), senhas com scrypt, isolamento por loja no servidor, auditoria, página fora dos buscadores (noindex), desligamento limpo e verificação de saúde (`/healthz`).

## Cuidados recomendados
- **Backups fora do servidor:** baixe um .db semanalmente (ou copie `/data/backups`) para a nuvem da empresa. Backup só no mesmo disco não protege contra perda do serviço.
- **LGPD:** o sistema guarda nome e telefone de clientes. Defina a base legal e o prazo de guarda com o jurídico, limite os usuários ao necessário e desative quem sair da equipe (*Administração → Usuários → Inativo*). Evite compartilhar o .db por e-mail/WhatsApp.
- **Uma instância só:** SQLite não suporta várias réplicas do servidor. Para o piloto (algumas dezenas de usuários) é mais que suficiente; se crescer muito, migre para PostgreSQL.
- **E-mail:** sem `SMTP_URL`, o escalonamento por e-mail não é enviado (o aviso no sistema continua).
