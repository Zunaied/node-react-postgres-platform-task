# TASK-1
## Creating docker compose to run the application
Prepared .env.example file to the application root directory
```
cp /home/kind/node-react-postgres-platform/backend/.env.example /home/kind/node-react-postgres-platform/.env

cd /home/kind/node-react-postgres-platform

vi .env

PORT=4000
DB_HOST=postgres
DB_PORT=5432
DB_USER=appuser
DB_PASSWORD=apppass
DB_NAME=appdb
DB_WRITE_URL=postgres://appuser:apppass@postgres:5432/appdb
DB_READ_URL=postgres://appuser:apppass@postgres:5432/appdb
REDIS_URL=redis://redis:6379
SEARCH_URL=http://search:9200
```

After that, created Dockerfiles for the backend and frontend and used multi-stage builds to reduce the size of both Docker images.

Dockerfile.backend

```
# install production dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev

# Multistage build: copy only the necessary files to the final image
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY backend/package*.json ./
COPY backend/src ./src
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
```

Dockerfile.frontend

```
# build the Vite app
FROM node:20-alpine AS build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# serve static files with nginx
FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

docker-compose.yaml

```
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
    security_opt:
      - seccomp:unconfined
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER} -d ${DB_NAME}"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped

  search:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.14.3
    environment:
      discovery.type: single-node
      xpack.security.enabled: "false"
      ES_JAVA_OPTS: "-Xms512m -Xmx512m"
    volumes:
      - searchdata:/usr/share/elasticsearch/data
    healthcheck:
      test: ["CMD-SHELL", "curl -s http://localhost:9200/_cluster/health | grep -qE 'green|yellow'"]
      interval: 10s
      timeout: 5s
      retries: 20
    restart: unless-stopped

  backend:
    build:
      context: .
      dockerfile: Dockerfile.backend
    environment: &backend-env
      PORT: ${PORT}
      DB_HOST: ${DB_HOST}
      DB_PORT: ${DB_PORT}
      DB_USER: ${DB_USER}
      DB_PASSWORD: ${DB_PASSWORD}
      DB_NAME: ${DB_NAME}
      DB_WRITE_URL: postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}
      DB_READ_URL: postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}
      REDIS_URL: ${REDIS_URL}
      SEARCH_URL: ${SEARCH_URL}
    ports:
      - "${PORT}:${PORT}"
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      search: { condition: service_healthy }
    restart: unless-stopped

  worker:
    build:
      context: .
      dockerfile: Dockerfile.backend
    command: ["node", "src/worker.js"]
    environment: *backend-env
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    restart: unless-stopped

  frontend:
    build:
      context: .
      dockerfile: Dockerfile.frontend
      args:
        VITE_API_URL: ${VITE_API_URL}
    ports:
      - "8080:80"
    depends_on:
      - backend
    restart: unless-stopped

volumes:
  pgdata:
  searchdata:
```


Now run docker compose:
```
docker compose up --build -d
docker compose ps
```

Beacuse, frontend container only serves static files (HTML, JS, CSS). The browser asks it for /api/items. Without this block, nginx finds no file with that name, so it returns index.html. For a POST it returns 405, because static files cannot take a POST.

The backend is a different container. nginx does not know about it unless you tell it.

![Image description](/images/unexpected-token.png)

When I try to add a new item, the application returns a 405 Method Not Allowed status.

![Image description](/images/405.png)

Added the following configuration to nginx.conf to forward API requests to the backend service running on port 4000.
``` 
   location /api/ {
        proxy_pass http://backend:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
```
### nginx.conf
```

server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location /api/ {
        proxy_pass http://backend:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location / {
        try_files $uri /index.html;
    }
}
```

Data is persisted using Docker volumes, ensuring that database data remains available even if the database container is stopped, restarted, or recreated.

![Image description](/images/data-docker.png)





# TASK-2


For Kubernetes, I have changed the server. The task specifies deployment in a Kind or Minikube environment, but I already have a Kubernetes environment set up using kubeadm, so I will complete the task in that environment.

### Nginx Reverse Proxy Configuration Update

Updated `nginx.conf` to use `backend-service` instead of `backend` as the backend Service name, following the Kubernetes configuration requirements.

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location /api/ {
        proxy_pass http://backend-service:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location / {
        try_files $uri /index.html;
    }
}
```

**Changes made:**
- Replaced `backend` with `backend-service` in the `proxy_pass` directive.
- Ensured Nginx forwards `/api/` requests to `backend-service` on port `4000`.
- Retained the client IP forwarding headers.
- Preserved the frontend's single-page application routing using `try_files`.

**Kubernetes requirement:** The `backend-service` Service must exist in the same namespace as the Nginx Pod, or the proxy URL must use the appropriate fully qualified Service DNS name.


### Building the Docker Image

Build the Docker image with the required tag:

```bash
docker build -f Dockerfile.backend  -t zunaied/node-react-backend:1.0.0 .
docker build -f Dockerfile.frontend -t zunaied/node-react-frontend:1.0.0 .```
```

### Pushing the Docker Image to Docker Hub

Log in to Docker Hub:

```bash
docker login
```
`if not done yet`
Tag the local image with your Docker Hub username and repository name:

```bash
docker tag frontend-app:v1.0.0 <dockerhub-username>/frontend-app:v1.0.0
```

Push the image to Docker Hub:

```bash
docker push zunaied/node-react-backend:1.0.0
docker push zunaied/node-react-frontend:1.0.0
```



![Image description](/images/image-push.png)

Verify the image in your Docker Hub repository.

![Image description](/images/repo.png)

### Creating the PostgreSQL Data Directory

Created a directory on the `scylladb03` Kubernetes worker node to store PostgreSQL data persistently.

```bash
sudo mkdir -p /data/postgres
```
### Kubernetes Manifest Organization

All Kubernetes manifests are organized under the `k8s/` directory, with separate subdirectories for each application component and configuration.

```text
k8s/
├── backend/
├── configuration/
├── frontend/
├── ingress/
├── namespace/
├── postgreql/
├── redis/
├── search/
└── storage/
```

**Directory descriptions:**
- `backend/` — Backend application Deployment and Service manifests.
- `configuration/` — Application configuration resources, such as ConfigMaps and Secrets.
- `frontend/` — Frontend application Deployment and Service manifests.
- `ingress/` — Ingress resources for external application access.
- `namespace/` — Kubernetes Namespace definitions.
- `postgreql/` — PostgreSQL database manifests. 
- `redis/` — Redis Deployment and Service manifests.
- `search/` — Search component resources.
- `storage/` — PersistentVolumes, PersistentVolumeClaims, and storage configuration.


# Task 3: Ingress Controller

### Installing the NGINX Ingress Controller

Apply the official NGINX Ingress Controller manifest for a bare-metal Kubernetes cluster:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.2/deploy/static/provider/baremetal/deploy.yaml
```

Wait until the controller Deployment finishes rolling out:

```bash
kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=300s
```

Verify the controller Pods and Services:

```bash
kubectl -n ingress-nginx get pods,svc
```

Created an Ingress resource named app-ingress in the dev namespace to route incoming HTTP requests to the frontend and backend Services based on the request path.

```
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app-ingress
  namespace: dev
spec:
  ingressClassName: nginx
  rules:
    - host: node-react.local
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: backend-service
                port:
                  number: 4000
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-service
                port:
                  number: 80

```



### Verifying Kubernetes Resources

To verify the deployed application resources in the `dev` namespace, run:

```bash
kubectl get all -n dev
```

This command displays common Kubernetes resources, including Pods, Services, Deployments, ReplicaSets, and replication controllers, in the `dev` namespace.


![Image description](/images/output.png)

### Fetching Items from the Backend API and checking data peristence 


![Image description](/images/persist.png)


### Accessing the Application Through the Ingress Hostname

The application is accessed using the hostname `node-react.local` because the NGINX Ingress resource defines a host-based routing rule.

```yaml
rules:
  - host: node-react.local
```

The Ingress Controller uses the HTTP `Host` header to determine which application's Service should receive an incoming request. Therefore, accessing the application by IP address or without the configured hostname may not match the Ingress rule.

**Application URL:**

```text
http://node-react.local:30472
```

**Local DNS configuration:** The hostname `node-react.local` must resolve to the machine or node IP address that exposes the Ingress Controller. For local testing, add an appropriate entry to the client's `/etc/hosts` file.

```text
<INGRESS_NODE_IP> node-react.local
```

Replace `<INGRESS_NODE_IP>` with the reachable IP address of your Kubernetes node.



![alt text](/images/image.png)

![alt text](/images/api.png)