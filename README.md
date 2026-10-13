# Revisão Premium | Registro e acompanhamento

App web (acessado pelo navegador) para o piloto Revisão Premium (Saga Toyota × KINTO Share), medindo apenas Goiás: lojas **Anápolis** e **Goiânia**.
O time de agendamento registra cada contato (nome, telefone, loja da revisão, resultado e motivo em menu suspenso). Quando o cliente **aceita**,
o time KINTO da loja da revisão recebe um aviso em tempo real, um consultor clica em **Atender** e registra a locação. Gestores acompanham o funil ao vivo.

## Rodar
```bash
npm install
ADMIN_EMAIL=voce@empresa.com ADMIN_PASSWORD='uma-senha-forte' npm start   # primeira vez: cria o Gestor KINTO
# abrir http://localhost:3000
```
Sem `ADMIN_PASSWORD`, uma senha provisória é gerada e mostrada uma única vez no terminal.
As lojas Anápolis e Goiânia já vêm criadas. Em **Administração**, crie os usuários (consultores KINTO exigem loja) e informe o e-mail de alerta de cada loja.
Para o aviso por e-mail funcionar, defina `SMTP_URL` (ver `.env.example`).

Demonstração com usuários e dados de exemplo (banco separado): `npm run demo`, depois abra http://localhost:3000. Os logins aparecem no terminal.

Testes automatizados da API: `npm test` (banco em memória, não toca nos dados reais).
Backup: automático (veja "Dados e backup" abaixo). Manual por linha de comando: `npm run backup`.

## Publicar na internet
Veja o **GUIA-PUBLICACAO.md** (Render ou servidor próprio com Docker + HTTPS). Em produção (`NODE_ENV=production`) o servidor exige `ADMIN_PASSWORD` com 10+ caracteres, força HTTPS e usa cookie Secure. Verificação de saúde: `/healthz`.

## Perfis
| Perfil | Acesso |
|---|---|
| Colaborador (agendamento) | Só a tela **Registrar**; escolhe a loja da revisão (Anápolis ou Goiânia). Não lê, edita nem exporta nada. A API recusa qualquer leitura (403). |
| Consultor KINTO | Só a tela **Atendimento KINTO**, e **somente clientes que aceitaram, da própria loja**. Assume o cliente (o primeiro clique vence), vê nome e telefone e registra a locação. Cliente de outra loja responde 404. |
| Gestor de loja | Painel, atendimento (todas as lojas), casos, edição de contatos, registro de locação e exportação CSV. |
| Gestor KINTO | Tudo acima, mais Administração: usuários, lojas (e-mail de alerta), listas de motivos e auditoria. |

## Fluxo de atendimento KINTO
1. Colaborador registra **Aceitou** ou **Ainda não decidiu** → o caso entra na fila da loja da revisão e os consultores daquela loja recebem aviso (toast, som, título da aba piscando e notificação do navegador, se permitida). A outra loja não recebe nada.
   (Indeciso entra com a etiqueta "Ainda não decidiu", para a KINTO entrar em contato; se depois virar "Recusou" e ninguém tiver assumido, sai da fila. Se virar "Aceitou", a etiqueta muda.)
2. Qualquer consultor da loja clica **Atender este cliente**. A gravação é atômica: se dois clicam juntos, um assume e o outro vê "Outro consultor já assumiu".
3. O consultor registra a locação (concluída ou não, motivo, datas, modelo, diárias, valor). Pode **devolver à fila**; o gestor pode **reatribuir** a um consultor da mesma loja.
4. Se ninguém assumir em `ESCALONA_MINUTOS` (padrão 15) em horário comercial, um e-mail (sem telefone) vai para o endereço de alerta da loja, uma única vez.
5. O painel mostra aguardando, maior espera, mediana até assumir e produção por consultor.

## Exportações (Gestor de loja e Gestor KINTO)
- **Painel:** Relatório do painel (CSV, todos os blocos com os filtros da tela), Contatos (CSV), Reservas (CSV) e **Gráficos e relatório (PDF)**, que abre a impressão do navegador: escolha "Salvar como PDF".
- **Casos:** Exportar casos (CSV), respeitando busca, situação e loja da tela, sem o limite de 300 linhas da lista.
- Os CSV abrem direto no Excel (UTF-8 com BOM, separador `;`, números no padrão pt-BR).

## Atualizações preservam os dados
Banco e backups ficam fora da pasta do programa em produção (`DATA_DIR`, padrão `~/revisao-premium-dados`). Ao detectar código novo o sistema faz um backup "antes de atualização"; se o banco sumir, restaura o backup mais recente. Detalhes no GUIA-PUBLICACAO.md.

## Dados e backup (Gestor KINTO → Administração → "Dados e backup")
- **Backup automático diário**: o servidor cria 1 cópia por dia, depois das 02:00 (`BACKUP_HORA`). Se estava desligado nesse horário, faz assim que ligar. Mantém os 14 mais recentes (`BACKUP_KEEP`). Pasta: `data/backups/` (`BACKUP_DIR`).
- **Fazer backup agora**: cópia manual na hora. **Baixar / Excluir** cada backup na lista.
- **Exportar banco completo (.db)**: baixa um arquivo com todos os dados (usuários, casos, contatos, reservas, atendimentos, auditoria). Serve para guardar fora do servidor ou levar para outra máquina.
- **Importar banco (.db)** e **Restaurar** um backup da lista: substituem TODOS os dados. Exige digitar RESTAURAR; o sistema valida o arquivo (integridade, tabelas, existência de um administrador ativo), guarda antes uma cópia "antes de restaurar" e, se algo falhar, nada é alterado. Depois, todos são desconectados e entram de novo.
- Backups de versões antigas do sistema são aceitos (colunas novas assumem o valor padrão); backups de versão mais nova que o sistema são recusados.
- Planilhas (Excel) continuam nos botões CSV do Painel e de Casos; o .db é para cópia de segurança, não para abrir no Excel.
- Dica: copie a pasta `data/backups/` periodicamente para outro lugar (nuvem, HD externo): backup no mesmo disco não protege contra perda do computador.

## Como os números são calculados
- **Caso** = cliente com revisão agendada (telefone + data da revisão). A confirmação liga ao caso existente pelo telefone.
- **Ofertados** = casos com resultado Aceitou, Recusou ou Ainda não decidiu. **Contatados** = qualquer resposta diferente de "Não atendeu".
- **Taxa de oferta** = ofertados ÷ agendamentos · **Aceite** = aceitaram ÷ ofertados · **Recuperação** = "ainda não decidiu" que aceitaram depois ÷ "ainda não decidiu".
- **Aceite → reserva** = reservas concluídas ÷ aceitaram · **Conversão total** = reservas concluídas ÷ agendamentos.
- **Aceite → reserva** conta só reservas de clientes que aceitaram; reserva fechada com cliente que ficou só indeciso entra em reservas e receita, mas não nessa taxa.
- **Não concluídas** = reservas registradas como "Não concluída"; **% não concluídas** = não concluídas ÷ (concluídas + não concluídas).
- **Ticket médio** = receita ÷ reservas concluídas · **Média de diárias** = diárias ÷ reservas concluídas.
- **Tempo do aceite até a reserva** = do primeiro "Aceitou" até o primeiro registro da reserva (mediana e média), separado entre concluídas e não concluídas. Reservas criadas antes desta versão usam a data da última atualização.
- **Comparativo**: cada indicador é comparado com o período imediatamente anterior de mesmo tamanho (ex.: 7 dias × 7 dias anteriores), com os mesmos filtros de loja e colaborador. Também está no CSV do painel.
- **Resultado por etapa**: contatos dos casos do período, separados em Agendamento e Confirmação (contatos, não atendeu, ofertas, aceites, recusas, indecisos, não ofertado; taxa de aceite = aceites ÷ ofertas; taxa de atendimento). **Origem dos aceites** = em que etapa cada caso aceitou pela primeira vez e, se foi na Confirmação, o que ele era antes (recusou, indeciso, sem oferta). Cuidado ao comparar: a Confirmação tende a falar com quem já está engajado, então uma taxa maior lá não significa, sozinha, que a ligação funciona melhor.
- Reservas e receita só contam o que o time KINTO (ou o gestor) registra na ficha. Aceitar na ligação não é locação.
- A **loja do caso** é a loja da revisão escolhida no agendamento; a confirmação não a altera.
- Para as taxas fazerem sentido, **todo agendamento deve entrar no app**, inclusive "Não atendeu" e "Não ofertado".

## Segurança
Senhas com scrypt, sessão em cookie HttpOnly/SameSite=Strict (12 h), limite de tentativas de login, política CSP restritiva,
exportação CSV neutralizando fórmulas, edições e inativações gravadas em auditoria, sem exclusão física de registros.
Em produção sirva atrás de HTTPS (`NODE_ENV=production` marca o cookie como Secure; use `TRUST_PROXY=1` atrás de proxy reverso).

## Limites conhecidos
- Banco SQLite em um único servidor: atende bem o volume do piloto. Se a TI exigir PostgreSQL ou várias instâncias, a camada de dados está concentrada em `db.js` e `server.js`.
- O aviso em tempo real só chega a quem está com o sistema aberto no navegador; o e-mail de escalonamento cobre quem não está olhando. Navegadores podem bloquear o som até o primeiro clique na página.
- Sem recuperação de senha por e-mail: o Gestor KINTO redefine em Administração.
- Sem integração com o sistema do KINTO Share nem com a agenda da loja (fases futuras).
