# DeepSeek Harness + Chutes.ai — contrato inicial para executor headless

**Status:** PROPOSTO / exemplo opt-in. Nenhum deploy, pairing, target novo, permissao MCP ou execucao Chutes esta implementado por este documento.

## Por que este slice existe

Separar o **coordenador** (ChatGPT usando Remote-Ops-MCP e GitHub) do **executor de codigo** (DeepSeek Harness headless em ambiente Linux isolado). Chutes.ai fornece modelos por uma rota customizada `openai-completions`, sem adaptador LLM proprio. O primeiro entregavel e a configuracao versionada com runbook; **nao** e autorizacao para executar comandos na VPS.

Fontes upstream consultadas (confirmar revisoes novamente antes de instalar):
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [configuracao de provedores](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md), [CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md) e [aviso de seguranca](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md).
- [Chutes starter guide](https://chutes.ai/docs/guides/starter-guide) e [catalogo de modelos](https://chutes.ai/models).
- Exemplo deste repositorio: [`config/examples/dsh-chutes-headless.patch.yml`](../config/examples/dsh-chutes-headless.patch.yml).

O Harness upstream declara status de **developer preview sem auditoria de seguranca**. Nao e considerado sandbox confiavel por si so.

## Contrato de modelo

| Campo | Valor inicial |
| --- | --- |
| Provider ID (fixo) | `chutes` |
| API | `openai-completions` |
| Base URL | `https://llm.chutes.ai/v1` |
| Credencial | Referencia `CHUTES_API_KEY`, sem valor no Git |
| Modelo padrao | `deepseek-ai/DeepSeek-V4-Flash-0731-TEE` |
| Outros modelos permitidos | `zai-org/GLM-5.1-TEE`, `Qwen/Qwen3-235B-A22B-Thinking-2507-TEE`, `moonshotai/Kimi-K2.6-TEE` |
| Input inicialmente declarado | `text` |
| Compatibilidade inicial | `supportsDeveloperRole: false`, `maxTokensField: max_tokens` (hipoteses, confirmar em smoke real) |

O exemplo e **uma lista inicial curada**, nao uma sincronizacao automatica do catalogo. IDs, capacidade de tool-calling, rate limits, parametros e precos variam. Confirmar os IDs com `GET https://llm.chutes.ai/v1/models` autenticado, comparar retorno com a lista do patch e fazer uma chamada real pequena **somente mediante autorizacao e com credencial gerenciada**. A busca de modelos no Harness nao significa que todas as respostas terao tool-calling correto.

O custo e por uso da API Chutes; processar quatro agentes em paralelo gera varias chamadas. O integrador deve impor budget por rodada, limite de tokens e simultaneidade, e separar modelo barato para rotina de modelo mais custoso para revisao.

## Preparacao de laboratorio — NAO executar em producao por esta PR

1. Escolher VM/container descartavel ou host dedicado, usuario nao privilegiado, sem `docker.sock`, SSH host, arquivos de clientes, credenciais de producao ou volumes de outros projetos. Diretiva externa de recursos/CPU/RAM/disk e obrigatoria antes do bootstrap.
2. Pinar uma release/tag/commit compatível do DeepSeek Harness. O README oferece `npx @deepseek-ai/dsh web` para executar pelo npm, mas **nao usar `latest` nao revisado** em implantacao. Instalar dependencias em imagem auditada.
3. Montar uma copia de trabalho do repositorio CRISE em volume isolado. Manter branches/worktrees independentes e GitHub token limitado ao repositorio, sem permissão de merge ou administracao.
4. Provisionar `CHUTES_API_KEY` via secret manager/env de processo isolado, nunca em `.env` commitado, CLI argumento, prompt, output, job artifact ou `cordis.patch.yml`.
5. Para conferir a composicao **sem chamar Chutes** (ajustar path absoluto de acordo com a imagem):

   ```sh
   cd /work/CRISE
   dsh --profile headless \
     --patch /opt/remote-ops-mcp/config/examples/dsh-chutes-headless.patch.yml \
     --dump-config
   ```

   O dump mostra a configuracao (sem a chave), e nao testa se a API responde. Nao publicar esse dump sem revisar campos.
6. Com credencial ja provisionada por canal seguro, testar uma tarefa **sintetica e sem leitura do projeto**:

   ```sh
   cd /work/CRISE
   dsh --profile headless \
     --patch /opt/remote-ops-mcp/config/examples/dsh-chutes-headless.patch.yml \
     --json 'Responda exatamente VIGIAFAST_CHUTES_OK. Nao use ferramentas e nao leia arquivos.'
   ```

   Exigir `final.text=VIGIAFAST_CHUTES_OK` e exit code 0; verificar provider/model e custo por meio de telemetria sanitizada. Nao confundir com o smoke Windows ja realizado com outro provedor.

**Cuidado com logs:** `--json` emite eventos de raciocinio (`thinking`). Qualquer ponte futura deve descartar `thinking` e payload bruto de ferramentas **antes** de persistir/transportar resultados. Projecao operacional permitida: ID de sessao, estados, duracao, codigo de saida, resumo sanitizado e resultado final revisado; aplicar redacao de PII e secrets. O filtro de log nao previne envio indevido de dados ao modelo: esse bloqueio deve acontecer antes da chamada.

## Gate de memoria canonica para cada tarefa CRISE

Antes da delegacao, o coordenador fixa e registra o commit da base real (atualmente, enquanto nao reconciliado, **nao assumir** `main` contendo BrightBean). O executor deve ler nesta ordem, **do mesmo checkout/commit autorizado**:

`docs/PROJECT_SOURCE.md` → `AGENTS.md` → `docs/CANONICAL_STATE.md` → `MEMORY.md` → status real das ADRs em `docs/decisions/` → doutrina, skills, codigo, testes e PRs relevantes.

Executar `REAL NOW → PROVEN EVIDENCE → GAPS → REUSE GATE → DECISION`. Falha de leitura, divergencia de SHA, ADR apenas PROPOSED ou politica contraditoria = **fail closed**, devolvendo ao coordenador. Um agente **nao decide aceitar uma ADR** por conta propria.

No fim de cada rodada, registrar: origem da tarefa, agente/modelo, base/head SHAs, arquivos alterados, testes realmente rodados, link da Draft PR, status CI observado **uma vez quando solicitado** e pendencias. `MEMORY.md` e `CANONICAL_STATE.md` devem ser reconciliados pelo integrador, nao editados concorrentemente por quatro agentes.

## Futuro contrato MCP tipado (NAO implementado)

A futura capability poderia expor `dsh.task.start`, `dsh.task.status`, `dsh.task.result` e `dsh.task.cancel`, com:

- alvo **somente** de laboratorio, `cwd` fixado em repo/worktree permitidos, binario `dsh` pinado, argv estruturado, `shell=false`, usuario sem privilegios;
- delegacao apenas para tarefa autorizada, com limites de tamanho, TTL, concorrencia inicial 1, timeout, cancelamento de grupo de processos e quota financeira;
- chave injetada por segredo local, sem acesso ao MCP ao valor; URLs de provider e modelos allowlisted;
- identidade autenticada, auditoria, write-scopes, deny de segredos e nenhuma permissao implicita para `main`, merge, ADR ou deploy;
- mensagens arbitrarias oriundas dos modelos consideradas nao confiaveis; nao tratar conteudo como autorizacao;
- resposta e logs filtrados antes do retorno pelo MCP, especialmente eventos `thinking` e argumentos brutos.

**Nenhuma nova capability e registrada no control plane, nenhum target e criado e nenhum agente passa a ser controlavel via ChatGPT por esta PR.** Para isso e necessario novo slice de codigo, threat model, testes negativos, revisao humana e autorizacao de rollout.

## Validacao / criterios de aceitacao desta proposta

- [x] Exemplo de provider em perfil `--patch` isolado, sem segredo literal.
- [x] Modelos documentados e relacionados ao mesmo provider ID.
- [x] Gates de memoria canonica, privacidade e controles de aprovacao descritos.
- [ ] Validar sintaxe/composicao com versao Linux pinada do `dsh`.
- [ ] Testar Chutes com chave gerenciada e chamada pequena autorizada.
- [ ] Testar tool-calling, eventos e sessao retomavel.
- [ ] Implementar capability MCP tipada em outra PR.
- [ ] Revisar seguranca de runtime e aprovar explicitamente implantacao.

Nenhum teste de Linux, inferencia, VPS ou CI e considerado green por este documento.
