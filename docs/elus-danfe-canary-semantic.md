# Elus VendaERP DANFE readonly canary — semantic boundary

Esta capability existe somente para executar uma passagem controlada do canário
`Elus → VendaERP → Pedido → Pessoa → contato → NFe → DANFE → preview`.

Ela **não** transforma o Remote-Ops em provider de ERP.

## Autoridade

A semântica de negócio continua no artefato do CRM-WANDORA/Elus:

- busca de pedido;
- prova de identidade Pedido → Pessoa → contato;
- consulta da NFe;
- validação/materialização segura do DANFE;
- upload do preview.

O Remote-Ops apenas orquestra uma imagem já qualificada por CI e pinada por
digest imutável. O caller não escolhe imagem, container de origem, rede, comando
nem variáveis de ambiente.

A autoridade Docker deste canário é ainda mais estreita: a origem Portainer é
pinada em `https://ops-vigia.wandora.com.br`, o endpoint esperado é `3` e a
credencial vem exclusivamente de `/app/secrets/portainer_vigia_api_key`. As
tools gerais de Portainer continuam usando `https://portainer.wandora.com.br`
e sua credencial própria. Ausência ou divergência dessa configuração falha
fechado; não há fallback do canário para Agent Mesh/Docker local.

## Efeitos permitidos

- VendaERP: **somente GET**;
- Supabase/Storage: um preview temporário do DANFE;
- WhatsApp: **nenhum envio**;
- VendaERP writes: **zero**.

A tool MCP é marcada como `mutation=true` e `idempotent=false` porque o preview
é uma escrita fora do VendaERP.

## Segredos

O proxy Docker lê internamente o `Config.Env` de um container Elus fixo e copia
somente:

- `NEXT_PUBLIC_SUPABASE_URL`;
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`;
- `SUPABASE_SERVICE_ROLE_KEY`;
- `AI_CRED_AES_KEY`.

Nenhuma outra variável atravessa o boundary. Esses valores existem apenas na
memória do proxy e no ambiente do container efêmero durante a execução. Eles
não entram no resultado MCP nem no recibo.

## Pin de supply chain

A configuração exige simultaneamente:

- repositório fixo `ghcr.io/oaranha/elus-danfe-canary`;
- referência `@sha256:...`;
- revisão Git de 40 hex.

Antes do start, o proxy confere `RepoDigests` e
`org.opencontainers.image.revision`. Divergência falha fechado.

## Uma execução real, sem retry

Há dois nomes fixos:

- candidate: execução efêmera;
- receipt: recibo permanente sem segredos.

O fluxo é:

1. recibo existente com o mesmo hash de escopo → devolve o resultado sanitizado
   com `replayed=true`, sem nova execução;
2. recibo existente com outro escopo → `canary_already_consumed`;
3. candidate existente e rodando → `canary_in_progress`;
4. candidate existente e parado → lê somente o JSON de saída, cria o recibo e
   remove o candidate, sem rerun;
5. primeira execução → cria/starta o candidate uma vez, materializa o resultado,
   cria o recibo e só então remove o candidate.

Assim, perda de resposta, timeout do transporte ou reinício do proxy não abre
uma segunda chamada real ao ERP.

## Isolamento do candidate

O container do canário:

- usa imagem por digest;
- não recebe Docker socket;
- não recebe bind mounts;
- `Privileged=false`;
- `CapDrop=ALL`;
- `no-new-privileges`;
- rootfs read-only;
- `/tmp` em tmpfs;
- sem restart;
- limites de memória/PIDs;
- rede fixa pela configuração do proxy.

## Saída

O proxy não repassa stdout bruto. O resultado é reconstruído por allowlist.

Sucesso expõe somente números de pedido/NFe, rótulos de evidência de identidade,
as três chamadas GET esperadas, tamanho/assinatura do PDF, estado do preview e
os invariantes `whatsapp_sent=false` / `vendaerp_writes=0`.

Falha expõe somente um `code` allowlisted. Detalhe de provider, CPF, telefone,
e-mail, conversation ID, storage path, signed URL, XML e payload ERP bruto são
descartados.
