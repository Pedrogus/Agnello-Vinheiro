# =====================================================================
# Vinheria Agnello - Dockerfile do auth-service
# Local no repositorio: auth/auth-service/Dockerfile
# Contexto do build: auth/auth-service (definido no docker-compose.yml)
# =====================================================================

# Imagem base: Node 24 em Alpine, com a versao FIXA (a mesma do seu
# ambiente local). Versao fixa = build de hoje igual ao de amanha.
# Evite "latest" e tags soltas como "node:alpine".
FROM node:24.19.0-alpine

# Pasta de trabalho dentro do container.
WORKDIR /app

# 1) Copia SO os arquivos de dependencias primeiro.
# O Docker guarda cada passo em cache: se so o codigo mudar, o npm ci
# abaixo NAO roda de novo e o build fica rapido.
COPY package.json package-lock.json ./

# 2) Instala exatamente as versoes do package-lock.json.
# --omit=dev deixa de fora o que e so de desenvolvimento.
# "npm ci" falha se o lockfile nao bater com o package.json (bom: seguro).
# O cache do npm e apagado para a imagem ficar menor.
RUN npm ci --omit=dev && npm cache clean --force

# 3) Agora sim copia o codigo do servico.
COPY src ./src

# Variaveis NAO secretas. Segredos (JWT_SECRET, senhas) NUNCA entram
# aqui: chegam em tempo de execucao pelo docker-compose.yml.
ENV NODE_ENV=production
ENV PORT=8081

# Seguranca: o processo roda como o usuario "node" (ja existe na imagem),
# e NAO como root. Se alguem explorar uma falha, tem menos poder.
USER node

# Documenta a porta do servico (nao publica nada para o seu PC).
EXPOSE 8081

# Verificacao de saude: o Docker chama /health de tempos em tempos.
# 127.0.0.1 (e nao "localhost") evita problema de IPv6 no Alpine.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/health || exit 1

# Inicia o servidor com "node" direto, e NAO com "npm start":
# assim o "docker stop" (SIGTERM) chega ao server.js e o encerramento
# limpo que voce escreveu funciona.
CMD ["node", "src/server.js"]