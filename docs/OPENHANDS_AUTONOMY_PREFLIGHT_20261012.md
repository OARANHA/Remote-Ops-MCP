# OpenHands — preflight de autonomia e contrato de entrada (2026-10-12)

**Status:** recorte defensivo proposto em PR Draft; nenhum deploy, merge, execução LLM ou mudança de target.

## Evidência reconciliada

- Fonte GitHub `main@0355eb97fac6737fee51746ae2211f6ff4981481`: `src/agent/openhands.ts` envia `POST /api/conversations`, `max_iterations:60`, `AlwaysConfirm`, `worktree:false` e workspace fixo `/projects/mcp-coordination-lab`.
- O MCP ativo respondeu `remote-ops-mcp/2.0.0-dev`; os targets `vigia-openhands-read` (read-only) e `vigia-openhands-execute` (semantic-operator) estão habilitados, e a saúde OpenHands foi `healthy:true`.
- A descrição operacional da ferramenta `openhands_start` ainda declara **20** iterações. O endpoint de saúde não expõe SHA/imagem do bridge. **60 em runtime NÃO PROVADO.**
- Chamadas `target_status` nos targets OpenHands foram negadas pela política semântica; não contornar com outro alvo.
- Não há prova de isolamento por missão, locks distribuídos, limites monetários, continuação automática, multiplexação de branches ou aprovação programática. `finished` não comprova êxito da tarefa.

## Menor mudança defensiva (esta PR)

- `openhands.start` agora rejeita qualquer opção diferente de `task` com `invalid_start_options`, antes de ler configurações de agente, abrir HTTP ou consumir LLM. Antes, opções extras eram ignoradas silenciosamente.
- Isso impede solicitar `workspace`, `branch`, `worktree`, `max_iterations`, `cost_limit` e `confirmation_policy` como se fossem políticas aplicadas.
- Não adiciona workspace novo, bloqueio de concorrência nem autoridade operacional; não altera a execução válida de `{task}` e mantém `AlwaysConfirm`.
- Testes sintéticos em `test-openhands-bridge.mjs` verificam rejeição e zero chamadas à API. **Testes locais não executados:** runner sem DNS para github.com. Aguardar CI sem polling.

## Reuse gate e ordem dos próximos passos

1. **P1:** comprovar imagem/commit rodando no gateway e no Agent Mesh Vigia usando inventário read-only permitido; comparar 20 vs 60; documentar rollout e rollback sem executar. A imagem operacional não deve ser inferida do package version.
2. **P1 observabilidade:** reutilizar `openhands_status`, `openhands_result`, `openhands_list` e, após verificar schema e exposição do tool, `openhands.events`. Consultar apenas UUIDs autorizados. Não equiparar término a sucesso.
3. **P2:** antes de paralelizar, revisar API OpenHands/SDK e Canvas para workspaces isolados reais, limite por repositório, worktrees/branches e concorrência no backend. O workspace fixo é risco de colisão, não sandbox. Sem prova, executar **uma missão de cada vez** no mesmo ambiente.
4. **P3:** documentar checkpoint verificável com UUID, commit base, branch, artefatos e estado; investigar endpoint existente de retomada. Não presumir auto-resume.
5. **P4/P5:** coordenação permanece com ChatGPT/contratos; Observatório horizontal consulta evidências reais sem receber segredos. Não introduzir scheduler, registry ou control plane paralelo.

## Segurança e verificação

- Apenas o proprietário aprova uma missão concreta com teto de gasto/modelo/escopo; `AlwaysConfirm` segue obrigatório.
- Nunca fazer deploy/merge/restart, aprovar acesso, iniciar conversa LLM ou escrever nos outros repositórios por esta PR.
- Rollback de código: reverter a PR, após aprovação de mudança operacional separada; não há migração de dados.
- Verificação futura: `npm ci && npm run build && node --experimental-strip-types --test test-openhands-bridge.mjs`; no runtime confirmar SHA implantado e uma única missão sintética com autorização explícita.
