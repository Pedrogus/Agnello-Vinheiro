// =====================================================================
// Vinheria Agnello - Jenkinsfile (pipeline declarativo)
// Local no repositorio: raiz do projeto (arquivo "Jenkinsfile", sem extensao)
// Fluxo: Checkout -> Ferramentas -> Build -> Teste -> Deploy -> Pos-build
// Roda no proprio container agnello-jenkins (que tem Node, npm e Git).
// Nenhum segredo real aparece aqui: o repositorio e publico e o teste
// usa valores descartaveis gerados na hora.
// =====================================================================

pipeline {

  // Executa no proprio Jenkins (nao ha agentes separados neste lab).
  agent any

  // ---------------------------------------------------------------
  // BLOCO 1 - OPCOES GERAIS
  // ---------------------------------------------------------------
  options {
    // Mantem so os 10 ultimos builds (o historico nao cresce sem limite).
    buildDiscarder(logRotator(numToKeepStr: '10'))
    // Se travar, derruba o build em 15 minutos.
    timeout(time: 15, unit: 'MINUTES')
    // Nunca dois builds ao mesmo tempo (evita conflito na pasta de deploy).
    disableConcurrentBuilds()
  }

  // O Jenkins roda em localhost e o GitHub nao consegue avisa-lo (webhook).
  // Entao ele consulta o repositorio a cada ~5 minutos ("H" espalha o minuto).
  triggers {
    pollSCM('H/5 * * * *')
  }

  // ---------------------------------------------------------------
  // BLOCO 2 - VARIAVEIS (nao secretas)
  // ---------------------------------------------------------------
  environment {
    // Pastas dos tres servicos, relativas a raiz do repositorio.
    SERVICOS   = 'auth/auth-service service/estoque-service service/pedidos-service'
    // Pasta de publicacao (volume ./deploy montado no container).
    DEPLOY_DIR = '/deploy'
  }

  stages {

    // -------------------------------------------------------------
    // ETAPA 1 - CHECKOUT: baixa o codigo do Git
    // -------------------------------------------------------------
    stage('Checkout') {
      steps {
        // Usa o repositorio configurado no job (Pipeline script from SCM).
        checkout scm
        sh 'git log -1 --pretty="Commit: %h - %s (%an)"'
      }
    }

    // -------------------------------------------------------------
    // ETAPA 2 - FERRAMENTAS: confirma que Node e npm existem
    // -------------------------------------------------------------
    stage('Ferramentas') {
      steps {
        sh '''
          node -v
          npm -v
        '''
      }
    }

    // -------------------------------------------------------------
    // ETAPA 3 - BUILD: instala as dependencias de cada servico
    // "npm ci" usa exatamente o package-lock.json e falha se divergir.
    // -------------------------------------------------------------
    stage('Build') {
      steps {
        sh '''
          for s in $SERVICOS; do
            echo "=== BUILD: $s ==="
            (cd "$s" && npm ci --omit=dev)
          done
        '''
      }
    }

    // -------------------------------------------------------------
    // ETAPA 4 - TESTE
    //  a) sintaxe de cada server.js;
    //  b) "smoke test": sobe cada servico por alguns segundos e confere
    //     se GET /health responde 200. Usa segredos DESCARTAVEIS.
    // -------------------------------------------------------------
    stage('Teste') {
      steps {
        sh '''
          for s in $SERVICOS; do
            echo "=== SINTAXE: $s ==="
            node --check "$s/src/server.js"
          done
        '''
        sh '''#!/bin/bash
          set -e

          # Valores aleatorios, validos so neste build. Nao sao os do .env.
          ALEATORIO() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40; }
          SEGREDO=$(ALEATORIO)
          SENHA1=$(ALEATORIO)
          SENHA2=$(ALEATORIO)

          # smoke <nome> <pasta> <porta> [VARIAVEL=valor ...]
          smoke() {
            nome=$1; pasta=$2; porta=$3; shift 3
            echo "=== SMOKE: $nome (porta $porta) ==="
            env "$@" PORT="$porta" node "$pasta/src/server.js" > "/tmp/smoke-$nome.log" 2>&1 &
            pid=$!
            ok=0
            for i in 1 2 3 4 5 6 7 8 9 10; do
              if node -e "fetch('http://127.0.0.1:$porta/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
                ok=1
                break
              fi
              sleep 1
            done
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
            if [ "$ok" -ne 1 ]; then
              echo "FALHA: $nome nao respondeu em /health. Log:"
              cat "/tmp/smoke-$nome.log"
              exit 1
            fi
            echo "OK: $nome respondeu /health"
          }

          smoke auth auth/auth-service 18081 \
            JWT_SECRET="$SEGREDO" \
            CLIENTE_USUARIO=ci-cliente CLIENTE_SENHA="$SENHA1" \
            ATENDENTE_USUARIO=ci-atendente ATENDENTE_SENHA="$SENHA2"

          # /health nao chama o Auth: a URL aqui so precisa ser valida.
          smoke estoque service/estoque-service 18083 \
            AUTH_URL=http://127.0.0.1:18081

          smoke pedidos service/pedidos-service 18082 \
            AUTH_URL=http://127.0.0.1:18081 ESTOQUE_URL=http://127.0.0.1:18083
        '''
      }
    }

    // -------------------------------------------------------------
    // ETAPA 5 - DEPLOY: publica na pasta /deploy (ver ./deploy no PC)
    // Copia so o necessario para construir a imagem: codigo, package*.json,
    // Dockerfile e .dockerignore. Fica de fora node_modules e .env.
    // Monta primeiro numa pasta temporaria e so depois troca a "current".
    // -------------------------------------------------------------
    stage('Deploy') {
      steps {
        sh '''#!/bin/bash
          set -e
          TMP="$DEPLOY_DIR/.tmp-$BUILD_NUMBER"
          rm -rf "$TMP"
          mkdir -p "$TMP"

          for s in $SERVICOS; do
            nome=$(basename "$s")
            echo "=== DEPLOY: $nome ==="
            mkdir -p "$TMP/$nome"
            cp -R "$s/src" "$TMP/$nome/src"
            cp "$s/package.json" "$s/package-lock.json" "$s/Dockerfile" "$TMP/$nome/"
            [ -f "$s/.dockerignore" ] && cp "$s/.dockerignore" "$TMP/$nome/" || true
          done

          # Manifesto: registra o que foi publicado, quando e por qual commit.
          {
            echo "build=$BUILD_NUMBER"
            echo "commit=$(git rev-parse --short HEAD)"
            echo "data=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
            echo "servicos=$SERVICOS"
          } > "$TMP/MANIFESTO.txt"
          cp "$TMP/MANIFESTO.txt" manifesto-deploy.txt

          # Troca a versao publicada.
          rm -rf "$DEPLOY_DIR/current"
          mv "$TMP" "$DEPLOY_DIR/current"
          echo "Publicado em $DEPLOY_DIR/current"
          ls -R "$DEPLOY_DIR/current" | head -50
        '''
      }
    }
  }

  // ---------------------------------------------------------------
  // BLOCO 3 - POS-BUILD
  // ---------------------------------------------------------------
  post {
    success {
      // Guarda o manifesto como evidencia no proprio build.
      archiveArtifacts artifacts: 'manifesto-deploy.txt', allowEmptyArchive: true
      echo 'Pipeline concluido com sucesso. Deploy publicado.'
    }
    failure {
      echo 'Pipeline FALHOU. Nada foi publicado alem do que ja estava em /deploy/current.'
    }
  }
}