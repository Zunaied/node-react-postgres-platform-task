pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    timeout(time: 40, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  environment {
    VERSION_BASE   = '1.0'
    REGISTRY       = 'docker.io'
    REGISTRY_USER  = 'zunaied'
    BACKEND_IMAGE  = "${REGISTRY}/${REGISTRY_USER}/node-react-backend"
    FRONTEND_IMAGE = "${REGISTRY}/${REGISTRY_USER}/node-react-frontend"
  }

  stages {

    // Map the branch to a namespace and build the image tag.
    stage('Prepare') {
      steps {
        script {
          def branch = env.BRANCH_NAME ?: 'unknown'
          if (branch == 'master' || branch == 'main') {
            env.TARGET_NS = 'dev';     env.APP_HOST = 'node-react.local'
          } else if (branch.startsWith('pre-release/v')) {
            env.TARGET_NS = 'preprod'; env.APP_HOST = 'preprod.node-react.local'
          } else if (branch.startsWith('release/v')) {
            env.TARGET_NS = 'release'; env.APP_HOST = 'release.node-react.local'
          } else {
            env.TARGET_NS = ''
          }
          def safe = branch.toLowerCase().replaceAll('[^a-z0-9._-]', '-')
          def sha  = sh(script: 'git rev-parse --short=7 HEAD', returnStdout: true).trim()
          env.IMAGE_TAG = "${env.VERSION_BASE}.${env.BUILD_NUMBER}-${safe}-${sha}"
          echo "branch=${branch} namespace=${env.TARGET_NS ?: 'none (build only)'} tag=${env.IMAGE_TAG}"
        }
      }
    }

    // npm ci and npm run build run inside the Dockerfiles (multi-stage builds).
    stage('Build images') {
      steps {
        sh '''
          docker build -f Dockerfile.backend  -t "$BACKEND_IMAGE:$IMAGE_TAG"  .
          docker build -f Dockerfile.frontend -t "$FRONTEND_IMAGE:$IMAGE_TAG" .
        '''
      }
    }

    // Only for master/main, pre-release/v*, release/v*.
    stage('Push images') {
      when { expression { env.TARGET_NS } }
      steps {
        withCredentials([usernamePassword(credentialsId: 'dockerhub-credentials',
                                          usernameVariable: 'DOCKERHUB_USER',
                                          passwordVariable: 'DOCKERHUB_TOKEN')]) {
          sh '''
            echo "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USER" --password-stdin
            docker push "$BACKEND_IMAGE:$IMAGE_TAG"
            docker push "$FRONTEND_IMAGE:$IMAGE_TAG"
          '''
        }
      }
    }

    // A person must approve a release deploy.
    stage('Approve release') {
      when { expression { env.TARGET_NS == 'release' } }
      steps {
        timeout(time: 30, unit: 'MINUTES') {
          input message: "Deploy ${env.IMAGE_TAG} to the release namespace?", ok: 'Deploy'
        }
      }
    }

    stage('Deploy') {
      when { expression { env.TARGET_NS } }
      steps {
        script { env.DEPLOY_STARTED = 'true' }
        withCredentials([file(credentialsId: 'kubeconfig-cicd', variable: 'KUBECONFIG')]) {
          sh '''
            set -eu
            rm -rf .render && mkdir .render
            cp -r k8s/configuration k8s/backend k8s/frontend k8s/ingress .render/

            # Point every manifest at the target namespace and host
            find .render -name '*.yaml' -exec sed -i \
              -e "s/namespace: dev/namespace: ${TARGET_NS}/" \
              -e "s/node-react.local/${APP_HOST}/" {} +

            # Use the images built in this run
            sed -i "s|image: .*node-react-backend:.*|image: ${BACKEND_IMAGE}:${IMAGE_TAG}|"   .render/backend/backend-deployment.yaml
            sed -i "s|image: .*node-react-frontend:.*|image: ${FRONTEND_IMAGE}:${IMAGE_TAG}|" .render/frontend/frontend-deployment.yaml

            # Only dev keeps the fixed NodePort
            if [ "$TARGET_NS" != "dev" ]; then
              sed -i '/nodePort:/d' .render/frontend/frontend-service.yaml
            fi

            # Secrets are NOT applied from Git. They are created once per namespace.
            kubectl apply -f .render/configuration/app-configmap.yaml
            kubectl apply -f .render/backend -f .render/frontend -f .render/ingress

            kubectl -n "$TARGET_NS" annotate deploy/backend deploy/frontend \
              kubernetes.io/change-cause="build ${BUILD_NUMBER} ${IMAGE_TAG}" --overwrite

            kubectl -n "$TARGET_NS" rollout status deploy/backend  --timeout=180s
            kubectl -n "$TARGET_NS" rollout status deploy/frontend --timeout=180s

            # Smoke test: the backend answers and can read the database
            kubectl -n "$TARGET_NS" exec deploy/backend -- wget -qO- http://localhost:4000/api/items > /dev/null
          '''
        }
      }
    }
  }

  post {
    failure {
      script {
        if (env.DEPLOY_STARTED == 'true') {
          withCredentials([file(credentialsId: 'kubeconfig-cicd', variable: 'KUBECONFIG')]) {
            sh '''
              kubectl -n "$TARGET_NS" rollout undo deploy/backend  || true
              kubectl -n "$TARGET_NS" rollout undo deploy/frontend || true
            '''
          }
        }
      }
    }
    always {
      sh 'docker logout || true'
      sh 'rm -rf .render'
    }
  }
}
