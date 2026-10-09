# VIGIAFAST — preset de target Agent Mesh para prova Docker offline

**Estado:** proposta em Draft PR, SEM deploy, SEM target novo registrado, SEM chave Chutes.

## Autoridade estrita

A PR #55 define `vigiafast_dsh_offline_probe`, operação semanticamente delimitada, mas nenhum dos presets de target oferecidos por `target_agent_prepare` concedia `vigiafast.dsh.offline_probe`. Essa lacuna tornava a operação inacessível pelo fluxo seguro de aprovação.

Esta mudança acrescenta o preset **`vigiafast-dsh-offline`** exclusivamente para `target_id=vigiafast-dsh-lab` e `environment=development`.

A baseline resultante é:

| Atributo | Valor |
| --- | --- |
| `transport` | `agent` |
| `capabilityProfile` | `operator` (necessário para mutação tipada no MCP) |
| `allowedSemanticCapabilities` | `["vigiafast.dsh.offline_probe"]` |
| `allowedPaths`, `allowedWritePaths`, `allowedProcessCwds`, `allowedProcessPrograms` | `[]` |
| `allowedDockerContainers`, `allowedDockerActions`, `allowedDockerExecContainers` | `[]` |
| `allowedServices`, `allowedServiceActions`, `allowedAdminPrograms`, `allowedAdminCwds` | `[]` |
| `allowedGitRepos` e demais permissões de Docker/image/rede/portas | `[]` |

Assim, `operator` **não equivale a acesso shell ou Docker genérico**: sem allowlist, a capability tradicional permanece negada.

Além disso, o próprio Agent Mesh deve iniciar com configuração explícita de **device de laboratório**:
- `VIGIAFAST_DSH_OFFLINE_DEVICE_MODE=1`;
- `DOCKER_HOST=tcp://127.0.0.1:23751` apontando ao proxy **isolado do laboratório**, nunca ao proxy de produção;
- nesse modo, o heartbeat do agente anuncia **somente** `vigiafast.dsh.offline_probe`; as operações genéricas de workspace, processo, Docker e managed-admin são recusadas pelo próprio agente;
- sem esse modo, a invocação da capacidade `vigiafast.dsh.offline_probe` também é recusada;
- `target_agent_prepare` e `target_agent_apply` exigem que o device ativo continue anunciando a capacidade no heartbeat. Configuração de variável de ambiente e heartbeat são sinais de configuração, **não** prova de isolamento de kernel, daemon Docker ou imagem.

O identificador `vigiafast-dsh-lab` fica **reservado**. Um preset genérico ou administrativo não pode conceder autoridade a esse ID. A preparação exige um device Agent Mesh real, pareado, com heartbeat e **não referenciado por outro target**. A aplicação (`APPROVE adm_...`) verifica novamente a exclusividade e o ambiente, inclusive se outro target foi aprovado enquanto o ticket aguardava autorização. Também é proibido atribuir o device do laboratório a outro target enquanto o laboratório existir.

## Procedimento futuro, não executar antes do gate operacional

Pré-condições: (i) aprovar e integrar a cadeia das PRs #51 → #52 → #54 → #55 → esta PR; (ii) comprovar CI no respectivo head; (iii) preparar infraestrutura de laboratório OS-isolated e um device Agent Mesh novo, sem acesso aos serviços existentes; (iv) instalar somente o Docker proxy do lab com imagem probe SHA-256 assinada/verificada; (v) nenhum segredo Chutes ou GitHub presente.

**Etapa lógica de registro, somente após a infraestrutura existir:** chamar `target_agent_prepare` com valores exatos:

```json
{
  "target_id": "vigiafast-dsh-lab",
  "device_id": "dev_ID_REAL_PAREADO_DO_LAB",
  "environment": "development",
  "preset": "vigiafast-dsh-offline"
}
```

O `device_id` acima é **placeholder ilustrativo**, não um identificador real nem convite a reutilizar o device `wandora-agent`. A ferramenta retorna `adm_...`, sujeito a confirmação literal do responsável. Somente então `target_agent_apply` persiste o target dinâmico. `target_agent_prepare` isoladamente não modifica o registry.

Após habilitação apropriada do proxy **no device isolado**, executar uma vez a ferramenta sem parâmetros livres:

```json
{"target":"vigiafast-dsh-lab"}
```

Usar apenas `vigiafast_dsh_offline_probe`, exigir `offline_lab_attestation.ok=true` e zero contêineres residuais. Nunca chamar `start_process(docker)` para contornar os bloqueios do target atual. Sem inferência, não é necessária API key Chutes.

## Segurança, CI e rollout

A CI desta PR testa:
- modo exclusivo do agente, opt-in exato e host de proxy loopback; rejeição de operações genéricas no device mesmo se enviadas pelo control plane;
- recusa de device que não anunciou a capability no prepare e de device que a perdeu antes do apply;
- ID de target exatamente reservado e `environment=development`;
- ausência de poderes genéricos de Docker, shell, escrita ou root;
- falha de preparação com preset administrativo/ID alternativo;
- ticket `adm_` não aplicado automaticamente e confirmação inválida negada;
- bloqueio de compartilhamento do device e de mudança entre prepare/apply (TOCTOU).

Nenhum teste em CI equivale a device Linux isolado provisionado. Docker daemon/host, associação à imagem egress, TTL e limpeza real continuam gates separados da [issue #53](https://github.com/OARANHA/Remote-Ops-MCP/issues/53).

**Atenção à integração:** o workflow `.github/workflows/container.yml` do repo executa build e publicação de imagem no GHCR quando há `push` para `main`; é preciso revisar a automação/efeitos antes de aprovar merges. Esta PR não faz merge nem deploy.

**JEV:** consulta de 2026-10-09 recomendou `deep_review` (~0,56) do caminho e `allow` (~0,74) para apenas preparar PR com preset de autoridade mínima. Parecer consultivo e não autorização de implantação.
