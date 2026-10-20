# DeepHarness ↔ Wandora Agent Mesh — pré-instalação controlada do relay (Stage 19)

**Estado: PREPARE-ONLY / NO-GO para ativação e deploy.** Este documento
acompanha a PR #71 em Draft. Em 2026-10-20, o proprietário aprovou
inicialmente a preparação do procedimento e, em aprovação posterior,
**o provisionamento exclusivo da identidade e do certificado cliente do
relay no host correto**. O operador concluiu essas etapas, mas **não
autorizou iniciar o relay, habilitar a operação no Agent Mesh, configurar
grants, alterar o backend mTLS, modificar Portainer ou enviar instruções
ao Lead**. Essas ações continuam sujeitas a autorizações separadas.

## Evidências verificadas no host certo

Operador em `root@28server` confirmou:

- `wandora-ops-agent.service`: ativo, `MainPID=8545`,
  `User=ops-mcp`, `Group=ops-mcp` — **UID 999 / GID 987**.
- `deepharness-web-1` e `deepharness-mcp-proxy-1`:
  `Config.User=1000:1000`, ambos anexados à
  `deepharness_mcp-private`.
- Rede Docker `deepharness_mcp-private`: **internal=true**,
  três contêineres no instante da consulta; backend web anuncia o alias
  fixo `deepharness-mcp-backend`.
- `deepharness-mcp-grants-db-1`: em execução e saudável na consulta.
- `/run/wandora/deepharness-semantic` e
  `/run/wandora/deepharness-semantic/bridge.sock`: **ausentes**.
- MCP Wandora health `ok` em OAuth; anteriores consultas por
  `deepharness-read` sofreram `agent_request_timeout`. Este erro
  não prova uma falha do serviço DSH.

**Ainda não verificado:** listener real `3443`, protocolo/mTLS aceito pelo
backend instalado, certificado cliente confiável e pin correto,
`Agent Mesh` WSS/dispatch atual, imagem digest-pinned, UID próprio do
relay, acesso à chave privada montada sem expor ao host agent, grants,
revogação ponta a ponta e resposta de Lead real.

## Checkpoint real de provisionamento — operador, 2026-10-20

Este checkpoint é posterior à preparação sintética Stage 19 e veio de
comandos executados diretamente em `root@28server` pelo proprietário.
A trilha abaixo é **evidência relatada pelo operador**, não prova de
leitura de arquivo ou execução remota pelo conector ChatGPT.

- `DSH_3443_TCP=OPEN` na rede privada; o TLS sem certificado cliente
  retornou `ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED`, consistente
  com política de **certificado cliente obrigatório**, mas sem comprovar
  a autenticação de um cliente confiável ou pin do novo certificado.
- CA backend existente: `CA:TRUE`, keyUsage `Certificate Sign, CRL
  Sign`, válida até 2031; único candidato de chave assinadora
  corresponde à chave pública da CA (`DSH_CA_KEY_MATCH=GREEN`).
- Operador criou conta de serviço `wandora-dsh-relay`:
  **UID 995, GID primário 985** (diferentes do host agent 999:987 e
  do DSH Web/proxy 1000:1000). Não é membro do grupo de socket 987
  no host; o futuro Compose declara `group_add` 987.
- Operador gerou uma chave privada exclusiva e certificado
  **clientAuth** assinado pela CA existente, com validade até
  **18/01/2027**, verificação de cadeia `GREEN`.
- Os arquivos criados inicialmente sob a árvore PKI `0700`
  propriedade root eram inacessíveis ao UID 995. Depois do
  diagnóstico `namei`, o operador **moveu somente o diretório
  exclusivo do relay** para outro pai acessível ao UID 995, sem
  liberar acesso à árvore compartilhada ou alterar a CA. O usuário
  do relay consegue ler a própria chave
  (`DSH_RELAY_KEY_ACCESS=GREEN`); a localização privada deve ser
  passada ao Compose por variáveis de operador, **sem registrar em
  Git, logs, respostas da ferramenta ou memória o caminho exato da
  chave, PEMs ou segredo**.
- `DSH_RELAY_RUNTIME=NOT_STARTED`; o diretório/socket Unix de
  Agent Mesh não foi criado, e a stack Portainer permanece inalterada.

**Pendências antes de qualquer deploy:** revisão de permissões
individualizadas da cópia da CA e do certificado, verificações do
certificado cliente pela identidade exata prevista, caminho
de certificados fora da árvore PKI inacessível, imagem do relay
construída com base imutável auditada, `DSH_BRIDGE_SERVER_FP_SHA256`
obtido de fonte confiável, provisionamento controlado do diretório
Unix exclusivo com owner UID 995 / socket group GID 987,
capacidade Agent Mesh anunciada pelo agente atualizado, e
reconciliação da política de pin do certificado cliente no DSH.
O backend da PR #17 verifica a impressão digital do cliente na
requisição além de exigir TLS autorizado; **não é suficiente apenas
assinar o certificado com a CA existente**. Alterar o pin do backend
ou testar uma chamada semântica real não faz parte deste gate.

## Gate 0 — inspecionar sem instalar

`integrations/deepharness/relay-host-preflight.mjs` é independente,
sem dependências externas; só executa quando chamado com
`--dry-run`. Usa `systemctl show`, `id`, `docker inspect`,
`docker network inspect` com templates restritos (sem ler
`Config.Env`), e `lstat` de dois caminhos fixos. Não abre listener,
não lê conteúdo de secret, não faz `docker exec`, `mkdir`, `chmod`,
`chown`, `useradd`, `docker run` ou chamada Agent Mesh.

Após checkout **da PR #71 revisada** no próprio host e avaliação do código
pelo operador (não executar código remoto sem revisão):

```bash
node integrations/deepharness/relay-host-preflight.mjs --dry-run
# Somente depois de verificar um UID candidato dedicado e não utilizado
# para o relay: --relay-uid=<UID_APROVADO>
```

É esperado `status=NO_GO` sem UID selecionado. O único resultado
favorável deste script, `PREPARE_ONLY`, **não** significa liberação
para deploy: ele não valida segredo, PKI, porta 3443 nem permissão
de execução real do Agent Mesh. Um novo contêiner jamais é criado
pelo preflight.

## Gate 1 — UID, grupo e diretório (futuro, autorização separada)

1. Selecionar e reservar, após checagem de colisão no HOST, um **UID
   de serviço não-root dedicado** ao relay. Não reutilizar 999 (host
   agent), 1000 (DSH Web/proxy), root, nem inferir automaticamente um
   valor a partir da imagem Docker. Verificar userns-remap/rootless e
   como o UID ficará mapeado em bind mounts. Não criar a conta agora.
2. Preservar GID **987** exclusivamente como grupo do socket. O relay
   usa um **grupo primário próprio** e `group_add: [987]`; seu
   usuário não deve pertencer ao grupo Docker nem a qualquer grupo
   que permita ler segredos de outros serviços.
3. Somente após aprovação, provisionar o diretório fixo
   `/run/wandora/deepharness-semantic` com
   `<relay_uid>:987` e modo **02710**. Conferir também ACL,
   umask, montagem do host, política MAC e atravessamento de
   diretórios-pai. O grupo do agente poderá atravessar, mas não
   listar/gravar a pasta.
4. O listener de `agent-mesh-unix-listener.mjs` recusará um socket
   preexistente; após opt-in do relay, criará `bridge.sock` com
   proprietário relayUID:987, modo **0660**, verificando tipo, inode
   e metadados. Nenhum `chmod 777`, symlink, fallback TCP ou
   propriedade 999 no diretório.
5. `/run` costuma ser volátil: planejar um mecanismo declarativo
   de **recriação do diretório após boot**, com dono/modo corretos,
   antes de qualquer habilitação operacional. Esse mecanismo não
   está instalado nesta etapa.

## Gate 2 — PKI, imagem e rede (futuro, autorização separada)

- A imagem do relay deve ser construída a partir de uma versão
  **Node 22** verificada, fixada por digest em
  `Dockerfile.agent-mesh-relay.review`, com hash do artefato
  final registrado pelo operador. **Não usar `latest`**,
  imagens não revisadas, downloads mutáveis, root ou `privileged`.
- Certificados mTLS: CA e certificado/chave cliente únicos, aprovados
  para o backend e armazenados no host em caminhos previamente
  revisados, isolados de `ops-mcp`. Montar três arquivos individualmente
  `read_only` no contêiner via nomes já fixados no Compose review.
  Não incluir PEM, fingerprints secretos nem caminho de chave
  em commits, logs, argumentos ao ChatGPT ou memória. Verificar
  validade, EKU, cadeia de confiança, revogação e fingerprint
  **contra fonte confiável independente**.
- Confirmar que backend DSH real ouve em TCP **3443** e realiza
  mTLS no hostname/SNI `deepharness-mcp-backend` dentro da rede
  privada; alias por si só não demonstra listener ou protocolo.
- O arquivo `agent-mesh-relay.compose.review.yml` permanece
  **isolado** da stack Portainer. Executar futuramente sempre
  com nome de projeto distinto `wandora-dsh-relay-stage`,
  `--profile dsh-relay-review`, imagem final imutável,
  `pull_policy: never`, sem `ports`, sem Docker socket,
  rede externa **somente** `deepharness_mcp-private`,
  `cap_drop: ALL`, `read_only`, `no-new-privileges`,
  `restart: no`. Não iniciar com variáveis fictícias de CI.
- `DSH_RELAY_OPERATOR_ENABLE` permanece **0** enquanto a ativação
  não estiver aprovada. Neste estado o executável falha fechado e
  pode encerrar: contêiner `Exited` é esperado, não uma falha a
  ser corrigida contornando o opt-in.

## Gate 3 — conexão e autoridade (futuro, autorização separada)

- Verificar saúde e identidade do Agent Mesh WSS existente; se
  `agent_request_timeout` persistir, **NO-GO**.
- Após revisão e ativação explícitas, validar socket 0660 acessível
  por `ops-mcp` e **inacessível** para outros usuários não
  autorizados. Não compartilhar o diretório de segredos mTLS com
  o host agent.
- Provisionar `deepharness-semantic-lab` somente pelo fluxo
  `target_agent_prepare` + confirmação humana
  `APPROVE adm_...` + `target_agent_apply`, depois de
  anúncio de `deepharness.semantic` pelo agente. Não modificar
  `deepharness-read`.
- Grants persistentes devem restringir **identidade OAuth existente,
  workspace de laboratório, Lead escolhido e operação**. Teste de
  leitura antes de escrita; qualquer envio de instrução ao Lead
  exige autorização separada.
- `accepted:true` comprova no máximo admissão na fila. Exigir
  readback independente da mensagem/resposta do Lead antes de
  declarar integração funcional.

## GO / NO-GO e reversão

**NO-GO imediato:** UID/GID não verificado, grupo ou socket
permissivo, acesso do agente à chave TLS, rede não interna,
alias DNS ausente, porta 3443/PKI não validados, Agent Mesh
indisponível, falta de grants exatos, container fora do projeto
separado, aprovação ausente ou qualquer tentativa de alterar
stack principal/publicar TCP. Nunca corrigir um NO-GO concedendo
`docker.sock`, shell root ou regras genéricas ao ChatGPT.

**Rollback de futuro canário aprovado (NÃO EXECUTAR AGORA):**

1. Suspender imediatamente novos pedidos semânticos via flag/target
   dedicado e **revogar grants** do workspace/Lead afetado,
   observando tickets em andamento segundo política de idempotência.
2. No **projeto separado** `wandora-dsh-relay-stage`, parar somente
   `dsh-agent-mesh-relay-review`; registrar o ID do contêiner e
   provar que não pertence à stack principal antes de removê-lo.
   Preservar opções Compose e a configuração de aprovação para
   execução/reversão auditável. Não executar `docker compose down`
   contra a stack Portainer `deepharness`.
3. Conferir `bridge.sock` com `lstat`; remover unicamente o
   socket/diretório exclusivos do relay **se** inode/proprietário e
   ausência de usuários estiverem comprovados, por procedimento
   aprovado. Não seguir symlinks. Manter backups/credenciais sob
   processo separado de revogação de certificados; não apagá-los
   automaticamente com o contêiner.
4. Restaurar eventual unidade Agent Mesh somente ao hash
   previamente aprovado, sem mudar o target `deepharness-read`.
   Verificar que serviços DSH Web/proxy/DB continuam disponíveis,
   que `dsh_*` não estão expostos, e registrar evidências.

**Resultado consolidado (até 2026-10-20):** a Stage 19 produziu
somente pré-instalação sintética e documentação Draft na PR #71. Sob
autorização **posterior e distinta**, o operador provisionou a
identidade e o certificado do relay diretamente no `28server` e
validou o acesso à chave, sem iniciar container, alterar Agent Mesh,
Portainer, target, grants ou Lead. A implantação segue NO-GO até
gate e autorização próprios.
