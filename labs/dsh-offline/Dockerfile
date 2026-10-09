# Fase A1 — somente teste de isolamento. NÃO instala DeepSeek Harness.
# Não carregar Chutes, credenciais, repositórios ou serviços do host.
# Para executar num laboratório separado requer autorização administrativa
# específica e revisão da imagem, recursos e Docker daemon.
FROM node:24.21.0-bookworm-slim

ENV NODE_ENV=production \
    HOME=/tmp \
    DSH_TELEMETRY_DISABLED=1

WORKDIR /opt/vigiafast
COPY --chown=0:0 probe.mjs mountinfo.mjs /opt/vigiafast/

# UID sem privilégios; o bind de projetos, Docker socket e rede são proibidos.
USER 10001:10001
ENTRYPOINT ["node", "/opt/vigiafast/probe.mjs"]
