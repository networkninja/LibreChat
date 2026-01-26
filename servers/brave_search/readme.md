# Brave-Search MCP Server (with PHI Guardrails)

This service exposes a **Brave Search** MCP tool that **blocks any query containing PHI**  
by first asking a LiteLLM-backed model to validate the prompt.

---

### What it does
1. Accepts a search query from LibreChat.
2. Sends a request to LiteLLM checking for PHI
3. If **clean**: forwards the query to Brave Search and returns results.  
   If **PHI detected**: returns a hard-stop error message—**no data ever leaves your network.**

---

### Environment Variables
Copy-paste the snippet below into `.env` and adjust the values.

```bash
# --- LiteLLM / OpenAI compatible backend
LLM_API_KEY="sk-12345"
LLM_PROXY_BASE_URL="https://proxy-site.com"

# --- Brave Search
BRAVE_API_KEY="xxxx"

# --- PHI Guardrail (model must be listed under /models endpoint of LiteLLM)
PHI_GUARDRAIL_MODEL="anthropic-claude-4-sonnet"

# --- Optional overrides
MCP_PORT=9001
BRAVE_SEARCH_LOG_PATH=/app/logs/brave_search.log
```

## Docker Setup Example
**1. Create the network (one-time setup):**
```bash
docker network create librechat-network
```

**2. Build the Brave Search image:**
```bash
cd servers/brave_search
docker build -t brave-search-mcp .
```

**3. Start Brave Search:**
```bash
docker run -d \
  --name brave-search-mcp \
  --network librechat-network \
  --env-file .env \
  -p 9001:9001 \
  -v $(pwd)/logs:/app/logs \
  brave-search-mcp
```

**4. Start LibreChat:**
```bash
docker run -d \
  -p 3080:3080 \
  --network librechat-network \
  --env-file .env \
  -v $(pwd)/librechat.yaml:/app/librechat.yaml \
  --name librechat-nni \
  librechat:nni
```

## LibreChat Config
```
mcpServers:
  braveSearch:
    type: streamable-http
    url: http://brave_search:9001/mcp
```
