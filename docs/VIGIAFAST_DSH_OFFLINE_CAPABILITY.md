# VIGIAFAST DSH — capability MCP governada para prova Docker offline

**Status:** código de PR Draft, NÃO implantado nem disponível no conector MCP atual.
**Dependências empilhadas:** PR #51 (provider Chutes), PR #52 (executor Linux) e PR #54 (probe offline).
**Referência de decisão:** [Issue #53](https://github.com/OARANHA/Remote-Ops-MCP/issues/53).
**Sem chave Chutes, sem modelo real, sem ligação a CRISE de produção.**

## Por que não usar Docker genérico?

O alvo `wandora-agent` e seu Docker proxy existentes suportam candidatos `wandora/web:candidate-*`, com rede `wandora-core` e porta 18090. Isso é **incompatível** com laboratório `network_mode=none` sem portas. Executar `docker run` via `start_process` seria contornar o enforcement de capability. Não o fazer.

Este slice adiciona somente uma operação de laboratório `vigiafast_dsh_offline_probe(target)`. Não expõe parâmetro para imagem, código, modelo, comando, argumentos, porta, rede, volume, usuário ou credencial.

## Autorizações determinísticas em duas camadas

**No control-plane MCP (`src/tools/index.ts`)**:
- O `target` deve ter ID exato `vigiafast-dsh-lab`, `environment=development`, `capabilityProfile=operator` e `transport=agent`, com `deviceId` ativo;
- Exige `allowedSemanticCapabilities` contendo **explicitamente** `vigiafast.dsh.offline_probe`; `*` não substitui a habilitação explícita;
- O device não pode ser compartilhado com outro target da registry;
- Toda chamada é auditada e retornada apenas como estrutura `offline_lab_attestation`. Sem novos targets nesta PR.

**No proxy Docker LOCAL do device dedicado**:
- Endpoint `POST /ops/vigiafast/dsh/offline-probe`, **desabilitado por padrão**;
- Só é habilitado se `VIGIAFAST_DSH_OFFLINE_IMAGE_SHA256=sha256:<64 caracteres hexadecimais minúsculos>` for configurado após review da imagem construída, existente localmente e comparada ao hash revisado. Nunca aceitar `latest`, tags arbitrárias ou pull automático;
- Payload da chamada deve ser `{}`; outra chave/argumento retorna erro sem Docker API;
- Exclusão mútua em processo, nome fixo `vigiafast-dsh-offline-probe`, operações `create → start → wait → logs → delete` por Unix socket;
- Se Docker diz que o nome já existe, não remove o contêiner existente. Se a operação criou o contêiner, remove no `finally`; se remoção falhar, retorna erro. Nenhuma tentativa de restart persistente;
- Retorna **somente os booleanos conhecidos** de atestação (renomeando o sinal `no_provider_secret` para `no_provider_material` para não conflitar com a redação de secrets do MCP). Logs, stderr, IDs, hostnames, env e payload não passam.

## Limites imutáveis da criação Docker

O create request construído pelo código contém:
- `Image` SHA-256 fixo; `User:10001:10001`;
- `NetworkDisabled:true` e `NetworkMode:none`, **zero portas**;
- `ReadonlyRootfs:true`, `Binds:[]`, `Mounts:[]`, `PortBindings:{}`;
- `CapDrop:["ALL"]`, `SecurityOpt:["no-new-privileges:true"]`, `Privileged:false`;
- Limites `Memory=256MiB`, `NanoCpus=0.5 CPU`, `PidsLimit=32`;
- `RestartPolicy.no`, `Init:true`, um tmpfs `/tmp` de 16MiB sem exec;
- Env restrito a `HOME=/tmp`, `DSH_TELEMETRY_DISABLED=1`, `NODE_OPTIONS` com limite de heap. Nenhuma chave externa.

**A imagem deve conter apenas o probe sintético da PR #54.** Não é permitido selecionar imagem do Harness neste endpoint. Image ID imutável *não prova* a origem da imagem; o operador deve vincular o ID a um artefato construído e verificado a partir do Dockerfile/commit revisados, com digest/assinatura e procedimento de instalação seguro.

## Preparação operacional (NÃO executar na VPS atual sem gate)

1. **Após CI verde e revisão de código da nova PR**, preparar device Agent Mesh de laboratório dedicado, com Docker proxy próprio, socket dedicado e política de host sem acesso a produção; não utilizar o device `wandora-agent` compartilhado.
2. Construir a imagem sintética em ambiente de build controlado. Importar apenas seu ID verificável para o daemon isolado. Não é permitido build remoto automático nem `latest` durante a invocação.
3. Exigir aprovação humana de implantação e autorização exata para registrar o target `vigiafast-dsh-lab`. O runtime/target não é criado ou alterado por esta PR.
4. Configurar somente nesse device `VIGIAFAST_DSH_OFFLINE_IMAGE_SHA256` na configuração protegida do proxy isolado; nunca habilitar no proxy Docker compartilhado de produção.
5. Executar uma única chamada `vigiafast_dsh_offline_probe({target:"vigiafast-dsh-lab"})`. Exigir `type=offline_lab_attestation`, `ok=true`, todos os checks verdadeiros, sessão finalizada, sem recursos residuais e audit trail.
6. Revogar/desativar temporariamente o target ao terminar, e documentar limpeza, recursos e eventuais falhas. Não prosseguir se aparecer erro `offline_lab_cleanup_failed`.
7. Só **depois** planejar A2: testes do `dsh` Linux sem credenciais dentro de isolamento real; fase B com chave Chutes em gateway externo ao usuário das tools e orçamento.

## Testes desta PR

- `test-dsh-offline-governed.mjs`: fixture Docker create, SHA-256 obrigatório, nenhuma rede, bind, porta, privilégio; atestação somente booleans conhecidos, rejeição de shape/saída falsos.
- `test-dsh-offline-proxy-mock.mjs`: daemon Docker fictício em Unix socket temporário; recusa payload com comando arbitrário, observa sequência create/start/wait/logs/delete, confirma sanitização de retorno e impede exclusão de contêiner preexistente no conflito.
- A CI roda os testes após `npm run build` e continua testando as capacidades anteriores. **Não equiparar CI ao teste em VPS nem à segurança operacional de um daemon Docker.**

## Riscos conhecidos e bloqueios

A operação de proxy, embora estrita, tem autoridade Docker de criação via socket no device onde é instalada. Se esse device acessar produção, sua própria segurança dependerá de controles do host/daemon não evidenciados por esta PR. **É obrigatório device/daemon próprio**. Falha de limpeza pode deixar contêiner residual; não repetir a chamada antes de investigar. Um `sha256:...` não autentica sozinho a procedência sem vinculação a um build revisado. Nenhum contêiner desta PR pode executar comandos de agente ou conectar à internet.

O modelo Chutes e as regras canônicas VIGIAFAST continuam fora do escopo desta PR. JEV.1 foi consultado: `deep_review` 0.52 para a rota; `confirm` 0.45 para a preparação da PR e `incomplete` 0.57 antes da documentação/CI. Resultados consultivos, não autorização de operação externa.
