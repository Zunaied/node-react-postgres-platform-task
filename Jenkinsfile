pipeline {
  agent any

  options {
    timestamps()
    timeout(time: 10, unit: 'MINUTES')
  }

  parameters {
    booleanParam(name: 'PUSH_TEST', defaultValue: false,
                 description: 'Also push a tiny test image to Docker Hub (zunaied/ci-credentials-test)')
  }

  stages {


    stage('Docker Hub') {
      steps {
        withCredentials([usernamePassword(credentialsId: 'dockerhub-credentials',
                                          usernameVariable: 'DOCKERHUB_USER',
                                          passwordVariable: 'DOCKERHUB_TOKEN')]) {
          sh '''
            set +x
            echo "Logging in to Docker Hub as $DOCKERHUB_USER"
            echo "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USER" --password-stdin

            if [ "$PUSH_TEST" = "true" ]; then
              set -x
              TEST_IMAGE="docker.io/${DOCKERHUB_USER}/ci-credentials-test:build-${BUILD_NUMBER}"
              docker pull busybox:1.36
              docker tag busybox:1.36 "$TEST_IMAGE"
              docker push "$TEST_IMAGE"
              echo "Push OK: $TEST_IMAGE"
            else
              echo "Login OK. Push test skipped (PUSH_TEST is false)."
            fi
          '''
        }
      }
    }

    stage('Kubeconfig') {
      steps {
        withCredentials([file(credentialsId: 'kubeconfig-cicd', variable: 'KUBECONFIG')]) {
          sh '''
            echo "--- context and API server (certificates are hidden)"
            kubectl config current-context
            kubectl config view --minify | grep -E 'server:|name:|user:'

            echo "--- can we reach the API?"
            kubectl get nodes -o wide
            kubectl get ns

            echo "--- what can this kubeconfig do in each namespace?"
            for ns in dev preprod release; do
              echo "== namespace: $ns"
              if kubectl get ns "$ns" > /dev/null 2>&1; then
                for check in "get pods" "get replicasets" "create deployments" "patch deployments" \
                             "create services" "create configmaps" "create ingresses" "create pods/exec"; do
                  printf '%-22s' "$check"
                  kubectl auth can-i $check -n "$ns" || true
                done
              else
                echo "namespace $ns does not exist yet"
              fi
            done
          '''
        }
      }
    }
  }

  post {
    always {
      sh 'docker logout || true'
    }
    success {
      echo 'Credentials test passed.'
    }
    failure {
      echo 'Credentials test failed. Read the red stage above.'
    }
  }
}
