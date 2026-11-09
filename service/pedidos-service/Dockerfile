# =====================================================================
# Vinheria Agnello - Dockerfile do pedidos-service
# Local no repositorio: service/pedidos-service/Dockerfile
# Contexto do build: service/pedidos-service (definido no docker-compose.yml)
# =====================================================================

# Mesma imagem base do auth-service: versao FIXA, igual ao Node local.
FROM node:24.19.0-alpine

WORKDIR /app

# 1) So os arquivos de dependencias primeiro (cache de camadas).
COPY package.json package-lock.json ./

# 2) Instala exatamente o que esta no package-lock.json, sem itens de dev.
RUN npm ci --omit=dev && npm cache clean --force

# 3) Codigo do servico.
COPY src ./src

# Variaveis NAO secretas. AUTH_URL chega pelo docker-compose.yml.
ENV NODE_ENV=production
ENV PORT=8082

# Seguranca: roda como o usuario "node", e NAO como root.
USER node

# Documenta a porta (nao publica nada para o seu PC).
EXPOSE 8082

# O /health nao exige token, entao o Docker consegue chamar sozinho.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8082/health || exit 1

# "node" direto (e nao "npm start"): o SIGTERM do "docker stop"
# chega ao server.js e o encerramento limpo funciona.
CMD ["node", "src/server.js"]