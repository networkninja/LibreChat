FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir fastmcp openai instructor pydantic requests python-dotenv

COPY brave_search.py /app/brave_search.py

CMD ["python", "brave_search.py"]
