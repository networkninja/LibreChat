# NNI LibreChat Build Instructions

This guide covers building and running the NNI fork of LibreChat.

---

## Prerequisites

- Docker installed and running
- MongoDB running (local or Docker)
- LiteLLM API key
- (Optional) API keys for Brave Search and Google Grounding MCP servers

---

## 1. Environment Configuration

### Update `.env` file

Edit the `.env` file in the project root with these required values:

```bash
# LibreChat Configuration Path
CONFIG_PATH="PATH/TO/YOUR/librechat.yaml" # e.g. /app/librechat.yaml
# MongoDB Connection
MONGO_URI="MONGODB-CONNECTION-STRING" # e.g. mongodb://host.docker.internal:27017/LibreChat

# LiteLLM API Keys (use the same key for both)
LITELLM_API_KEY="YOUR-LITELLM-API-KEY-HERE"
RAG_OPENAI_API_KEY="YOUR-LITELLM-API-KEY-HERE"
```

---

## 2. LibreChat Configuration

### Update `librechat.yaml`

#### Configure Custom Endpoint (Required)

Update the NNI Models endpoint with your LiteLLM API key:

```yaml
endpoints:
  custom:
    - name: "NNI Models"
      apiKey: "YOUR-LITELLM-API-KEY-HERE"
      baseURL: "https://aimlapi-dev.networkninja.com/v1"
      models:
        default: ["gpt-4.1-mini"]
        fetch: true
      titleConvo: true
      titleModel: "gpt-4.1-mini"
      modelDisplayLabel: "NetworkNinja LLMs"
```

#### Configure Brave Search (Optional)

Basic configuration:
```yaml
mcpServers:
  brave-search:
    type: stdio
    command: npx
    args:
      - -y
      - "@brave/brave-search-mcp-server"
      - "--transport"
      - "stdio"
      - "--enabled-tools"
      - "brave_web_search"
      - "brave_news_search"
    env:
      BRAVE_API_KEY: "YOUR-BRAVE-API-KEY-HERE"
    timeout: 60000
    initTimeout: 15000
```

#### Configure Google Grounding (Optional)
If using Google Grounding MCP server, add your API key:

```yaml
mcpServers:
    google-grounding:
        type: "streamable-http"
        url: "https://mapstools.googleapis.com/mcp"
        headers:
        X-Goog-Api-Key: "YOUR-GOOGLE-MAPS-API-KEY-HERE"
        timeout: 60000
        initTimeout: 15000
```
---

## 3. Build the Docker Image

Build LibreChat with the `--no-cache` flag to ensure a clean build:

```bash
docker build --no-cache -f librechat-nni-fork-dockerfile -t librechat:nni .
```

---

## 4. Run LibreChat

### Default: Run with terminal output (Recommended)

This keeps logs visible in your terminal for debugging:

```bash
docker run \
  -p 3080:3080 \
  --network librechat-network \
  --env-file .env \
  -v $(pwd)/librechat.yaml:/app/librechat.yaml \
  --name librechat-nni \
  librechat:nni
```

Press `Ctrl+C` to stop the container.

---

### Alternative: Run in background (detached mode)

If you want to run LibreChat in the background:

```bash
docker run -d \
  -p 3080:3080 \
  --network librechat-network \
  --env-file .env \
  -v $(pwd)/librechat.yaml:/app/librechat.yaml \
  --name librechat-nni \
  librechat:nni
```

---

## 5. Access LibreChat

Open your browser to: **http://localhost:3080**

You should see the LibreChat interface. Register a new account or log in.

---
