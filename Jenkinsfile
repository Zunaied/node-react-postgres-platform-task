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

    // Map the branch to a namespace and a manifest folder. Build the image tag.
    stage('Prepare') {
      steps {
        script {
          def branch = env.BRANCH_NAME ?: 'unknown'
          if (branch == 'master' || branch == 'main') {
            env.TARGET_NS = 'dev';     env.K8S_DIR = 'k8s'
          } else if (branch.startsWith('pre-release/v')) {
            env.TARGET_NS = 'preprod'; env.K8S_DIR = 'k8s.preprod'
          } else if (branch.startsWith('release/v')) {
            env.TARGET_NS = 'release'; env.K8S_DIR = 'k8s.release'
          } else {
            env.TARGET_NS = ''
            env.K8S_DIR   = ''
          }
          def safe = branch.toLowerCase().replaceAll('[^a-z0-9._-]', '-')
          def sha  = sh(script: 'git rev-parse --short=7 HEAD', returnStdout: true).trim()
          env.IMAGE_TAG = "${env.VERSION_BASE}.${env.BUILD_NUMBER}-${safe}-${sha}"
          echo "branch=${branch} namespace=${env.TARGET_NS ?: 'none (build only)'} folder=${env.K8S_DIR ?: 'none'} tag=${env.IMAGE_TAG}"
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

            echo "Deploying from folder: $K8S_DIR to namespace: $TARGET_NS"
            test -d "$K8S_DIR" || { echo "Folder $K8S_DIR not found"; exit 1; }

            # Work on a copy. Git files stay unchanged.
            rm -rf .render && mkdir .render
            cp -r "$K8S_DIR"/. .render/

            # Safety check: every namespace in the folder must match the target.
            bad=$(grep -rhE '^[[:space:]]*namespace:' .render | grep -vE "namespace:[[:space:]]*${TARGET_NS}[[:space:]]*$" || true)
            if [ -n "$bad" ]; then
              echo "Wrong namespace found in $K8S_DIR (expected $TARGET_NS):"
              echo "$bad"
              exit 1
            fi

            # Use the images built in this run
            sed -i "s|image: .*node-react-backend:.*|image: ${BACKEND_IMAGE}:${IMAGE_TAG}|"   .render/backend/backend-deployment.yaml
            sed -i "s|image: .*node-react-frontend:.*|image: ${FRONTEND_IMAGE}:${IMAGE_TAG}|" .render/frontend/frontend-deployment.yaml

            # Secrets are NOT applied from Git. They are created once per namespace.
            # Apply in order. Skip a folder if it does not exist.
            for d in namespace configuration storage postgreql redis search backend frontend ingress; do
              if [ -d ".render/$d" ]; then
                echo "Applying $d"
                kubectl apply -f ".render/$d"
              fi
            done

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
              for d in backend frontend; do
                if kubectl -n "$TARGET_NS" get deploy/$d > /dev/null 2>&1; then
                  kubectl -n "$TARGET_NS" rollout undo deploy/$d || echo "No old revision for $d. Skipping rollback."
                else
                  echo "deploy/$d does not exist in $TARGET_NS. Nothing to roll back."
                fi
              done
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
