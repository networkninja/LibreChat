from fastmcp import FastMCP
import os
import datetime
import requests
import json

from typing import Optional
from pydantic import BaseModel, Field

from openai import OpenAI
import instructor
from dotenv import load_dotenv

LLM_API_KEY = os.getenv("LLM_API_KEY")
if not LLM_API_KEY:
    raise RuntimeError("LLM_API_KEY environment variable not set")

proxy_base_url = os.getenv("LLM_PROXY_BASE_URL")
if not proxy_base_url:
    raise RuntimeError("PROXY_BASE_URL environment variable not set")

MCP_PORT = int(os.getenv("MCP_PORT", "9001"))

phi_guardrail_model = os.getenv("PHI_GUARDRAIL_MODEL", "claude-3.7-sonnet")

# Get Brave API key from environment variable
BRAVE_API_KEY = os.getenv("BRAVE_API_KEY")
if not BRAVE_API_KEY:
    print("ERROR: BRAVE_API_KEY environment variable not set")
    raise RuntimeError("ERROR: BRAVE_API_KEY environment variable not set")
    
# Set up logging
default_log_path = "/app/logs/brave_search.log"
LOG_PATH = os.getenv("BRAVE_SEARCH_LOG_PATH", default_log_path)

log_dir = os.path.dirname(LOG_PATH)

# Ensure the parent directory exists
os.makedirs(log_dir, exist_ok=True)

# If the log path exists and is a directory, that's an error
if os.path.isdir(LOG_PATH):
    raise RuntimeError(f"Log path {LOG_PATH} is a directory, expected a file.")

def write_log(message: str):
    """Write a log message to the log file."""
    with open(LOG_PATH, 'a') as log_file:
        log_file.write(f"{datetime.datetime.now()} - {message}\n")
        
instructor_client = instructor.from_openai(OpenAI(api_key=LLM_API_KEY, base_url=proxy_base_url))

write_log("Brave Search server started.")

# Initialize FastMCP server
mcp = FastMCP("brave_search")

def prompt_contains_phi(text, model):
    class PromptValidation(BaseModel):
        contains_phi: bool = Field(default=False, description="Indicates if the prompt contains PHI.")

    PHI_GUARDRAIL_PROMPT = f"""
    You are an expert in identifying and preventing the disclosure of Protected Health Information (PHI) in text.
    Your task is to analyze the provided text and determine if it contains any PHI.
    IMPORTANT: This agent should NEVER allow PHI to slip through and should return "True" if PHI is detected.
    PHI Detection Guidelines
    Monitor for:

    Names (first name, last name, maiden names) in the context of healthcare
    Birth dates and dates of birth
    Admission dates
    Discharge dates
    Date of death
    Telephone numbers
    Fax numbers
    Email addresses
    Physical addresses (street address, city, county, zip code)
    Social Security Numbers (SSN)
    Medical record numbers
    Health plan beneficiary numbers
    Patient account numbers
    Insurance account numbers
    Certificate/license numbers (including medical license numbers)
    Vehicle identifiers (license plate numbers, VINs)
    Device identifiers and serial numbers (medical devices)
    Web URLs associated with the individual
    IP addresses
    Insurance information (policy numbers, group numbers)
    Employment information
    Emergency contact details
    Medical history
    Diagnosis codes
    Treatment information
    Medication history
    Lab results
    Genetic information
    Any other unique identifying number, characteristic, or code
    Multiple demographic data points that could identify a patient
    Data appearing to be from medical records or healthcare databases

    Here is the text to validate for PHI:
    {text}
    """
    
    model_response = instructor_client.chat.completions.create(
        model=model,
        response_model=PromptValidation,
        max_retries=3,
        messages=[
            {"role": "user", "content": PHI_GUARDRAIL_PROMPT},
        ]
    )
    return model_response.contains_phi


@mcp.tool()
async def brave_web_search(query: str, count: int = 5) -> str:
    """
    Perform a web search using Brave Search API.
    
    Args:
        query: The search query string
        count: Number of results to return (default: 5)
    
    Returns:
        JSON string containing search results
    """

    contains_phi = prompt_contains_phi(
        query,
        phi_guardrail_model
    )

    if contains_phi:
        write_log("PHI detected in search query, returning error response")
        return json.dumps({
            "isError": True,
            "message": """Search query contains PHI unrelated to nonprofit research.
            IMMEDIATELY STOP all API calls and external service requests
            DO NOT store, process, or transmit the suspected PHI
            Display this alert: "⛔ PHI DETECTED - Please remove all protected health information before continuing ⛔"
            Refuse to continue until PHI is removed
            For repeated violations, suggest secure alternatives for research"""
        })

    
    if not BRAVE_API_KEY:
        return json.dumps({
            "isError": True,
            "message": "BRAVE_API_KEY not configured"
        })
    
    try:
        # Validate and limit count
        if not isinstance(count, int) or count < 1:
            count = 5
        count = min(count, 20)  # Cap at 20 results max
        
        # Perform search using Brave API
        headers = {
            "Accept": "application/json",
            "X-Subscription-Token": BRAVE_API_KEY
        }
        
        params = {
            "q": query,
            "count": count
        }
        
        response = requests.get(
            "https://api.search.brave.com/res/v1/web/search",
            headers=headers,
            params=params
        )
        
        if response.status_code != 200:
            write_log(f"Error from Brave API: Status {response.status_code}")
            return json.dumps({
                "isError": True,
                "message": f"Brave API returned status code {response.status_code}"
            })
        
        results = response.json()
        
        # Format results into a more concise structure
        formatted_results = {
            "query": query,
            "content": []
        }
        
        if "web" in results and "results" in results["web"]:
            for item in results["web"]["results"][:count]:
                formatted_results["content"].append({
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "description": item.get("description", "")
                })
        
        write_log(f"Search completed successfully with {len(formatted_results['content'])} results")
        return json.dumps(formatted_results)
    
    except Exception as e:
        write_log(f"Error performing search: {str(e)}")
        return json.dumps({
            "isError": True,
            "message": f"Error performing search: {str(e)}"
        })

if __name__ == "__main__":
    # Initialize and run the server
    try:
        write_log(f"Starting Brave Search server on 0.0.0.0:{MCP_PORT}")
        mcp.run(transport='streamable-http', host='0.0.0.0', port=MCP_PORT)
    except Exception as e:
        error_msg = f"Error starting server: {e}"
        write_log(error_msg)
        print(error_msg)
