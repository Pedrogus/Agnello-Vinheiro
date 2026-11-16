# =====================================================================
# Vinheria Agnello - Dockerfile do Jenkins (CI/CD)
# Local no repositorio: infra/jenkins/Dockerfile
# Contexto do build: infra/jenkins (definido no docker-compose.yml)
# Imagem oficial do Jenkins + Node.js, para o pipeline rodar "npm ci".
# =====================================================================

# ---------------------------------------------------------------------
# ESTAGIO 1 - so serve de ORIGEM do Node (nao vai para a imagem final).
# Mesma versao dos servicos (24.19.0), na variante Debian ("bookworm"),
# que e a base do Jenkins. A variante Alpine NAO funcionaria aqui.
# ---------------------------------------------------------------------
FROM node:24.19.0-bookworm-slim AS node

# ---------------------------------------------------------------------
# ESTAGIO 2 - imagem final: Jenkins (LTS, Java 21).
# DICA: depois do primeiro build, descubra a versao exata com
#   docker run --rm <imagem> jenkins --version
# e troque "lts-jdk21" por algo como "2.xxx.x-lts-jdk21" (versao FIXA).
# ---------------------------------------------------------------------
FROM jenkins/jenkins:lts-jdk21

# Instalar arquivos fora do usuario "jenkins" exige root, so neste trecho.
USER root

# Copia o programa "node" e o "npm" do estagio 1.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

# Recria os atalhos "npm" e "npx" (o COPY nao leva os links).
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node -v && npm -v

# Pasta de publicacao: o pipeline copia o resultado do deploy para ca.
# O volume ./deploy do compose e montado nesta pasta.
RUN mkdir -p /deploy && chown jenkins:jenkins /deploy

# Seguranca: volta para o usuario "jenkins". NUNCA deixe o Jenkins como root.
USER jenkins
