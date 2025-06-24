from mcp.server.fastmcp import FastMCP
import os
import sys
import requests
import json
from datetime import datetime
import argparse

# Initialize FastMCP server
mcp = FastMCP("sentry_issue_manager")

# Parse command-line arguments
parser = argparse.ArgumentParser(description="Sentry Issue Manager MCP Server")
parser.add_argument('--sentry_auth_token', required=True, help="Sentry authentication token")
parser.add_argument('--sentry_organization_slug', required=True, help="Sentry organization slug")
parser.add_argument('--sentry_organization_id', required=True, help="Sentry organization ID")
args = parser.parse_args()

# Use the parsed arguments
AUTH_TOKEN = args.sentry_auth_token
ORGANIZATION_SLUG = args.sentry_organization_slug
ORGANIZATION_ID = args.sentry_organization_id

# check that the parser arguments are set
if not AUTH_TOKEN or not ORGANIZATION_SLUG or not ORGANIZATION_ID:
    print("Error: Sentry authentication token, organization slug, and organization ID must be provided.")
    # write to ./logs.txt
    with open("logs.txt", "a") as log_file:
        log_file.write("Error: Sentry authentication token, organization slug, and organization ID must be provided.\n")
    # exit the program
    sys.exit(1)

@mcp.tool()
async def sentry_list_projects(cursor: str = None) -> str:
    """List all projects available to the authenticated session.
    
    Args:
        cursor: Optional. A pointer to the last object fetched and its sort order; 
               used to retrieve the next or previous results.
               
    Returns:
        str: Formatted list of available Sentry projects
    """
    url = "https://sentry.io/api/0/projects/"
    headers = {
        "Authorization": f"Bearer {AUTH_TOKEN}"
    }
    
    params = {}
    if cursor:
        params["cursor"] = cursor
    
    try:
        response = requests.get(url, headers=headers, params=params)
        response.raise_for_status()  # Raise an exception for bad status codes
        
        try:
            projects = response.json()
        except json.JSONDecodeError:
            return "Error: Unable to parse JSON response"
        
        if not projects:
            return "No projects found."
        
        result = "Available Projects:\n"
        for project in projects:
            org = project.get('organization', {})
            org_slug = org.get('slug', 'Unknown')
            org_name = org.get('name', 'Unknown')
            project_name = project.get('name', 'Unnamed')
            project_slug = project.get('slug', 'unknown')
            project_id = project.get('id', 'unknown')
            platform = project.get('platform', 'Unknown')
            
            result += f"Organization: {org_name} ({org_slug}) | "
            result += f"Project: {project_name} (ID: {project_id}, slug: {project_slug}) | "
            result += f"Platform: {platform}\n"
        
        # Add pagination information if available
        links = response.headers.get('Link')
        if links and 'cursor=' in links:
            result += "\n(Use the cursor parameter for pagination to see more results)"
            
        return result
    except requests.RequestException as e:
        return f"Error retrieving projects: {str(e)}"
    except Exception as e:
        return f"Exception occurred: {str(e)}"


@mcp.tool()
async def sentry_list_project_issues(organization_slug: str, project_slug: str, limit: int = 10) -> str:
    """List recent issues from a specific Sentry project.
    Args:
        organization_slug: Slug of the Sentry organization
        project_slug: Slug of the Sentry project
        limit: Maximum number of issues to return (default: 10)
    Returns:
        str: List of issues with their details for the specified project
    """
    url = f"https://sentry.io/api/0/projects/{organization_slug}/{project_slug}/issues/"
    headers = {
        "Authorization": f"Bearer {AUTH_TOKEN}"
    }
    params = {"limit": limit}

    try:
        response = requests.get(url, headers=headers, params=params)
        response.raise_for_status()  # Raises an HTTPError for bad responses
        
        issues = response.json()
        if not issues:
            return f"No issues found for project {project_slug}."
        
        result = f"Recent Issues for {project_slug}:\n\n"
        for issue in issues:
            result += f"ID: {issue['id']}\n"
            result += f"Title: {issue['title'][:100]}...\n"  # Truncate long titles
            result += f"Type: {issue['type']}\n"
            result += f"Level: {issue['level']}\n"
            result += f"Status: {issue['status']}\n"
            result += f"First Seen: {datetime.fromisoformat(issue['firstSeen'][:-1]).strftime('%Y-%m-%d %H:%M:%S')}\n"
            result += f"Last Seen: {datetime.fromisoformat(issue['lastSeen'][:-1]).strftime('%Y-%m-%d %H:%M:%S')}\n"
            result += f"Count: {issue['count']}\n"
            result += f"User Count: {issue['userCount']}\n"
            result += f"Culprit: {issue['culprit']}\n"
            result += f"Priority: {issue['priority']}\n"
            result += f"Permalink: {issue['permalink']}\n"
            result += "\n"
        
        return result

    except requests.RequestException as e:
        return f"Error retrieving project issues: {str(e)}"
    except Exception as e:
        return f"Exception occurred: {str(e)}"

@mcp.tool()
async def sentry_get_issue_details(issue_id: str) -> str:
    """Get detailed information about a specific issue.
    Args:
        issue_id: ID of the Sentry issue to retrieve
    Returns:
        str: Issue details in formatted text
    """
    url = f"https://sentry.io/api/0/issues/{issue_id}/"
    headers = {
        "Authorization": f"Bearer {AUTH_TOKEN}"
    }

    try:
        response = requests.get(url, headers=headers)
        if response.status_code == 200:
            issue_data = response.json()
            return (f"Issue Details:\n"
                   f"Title: {issue_data['title']}\n"
                   f"Status: {issue_data['status']}\n"
                   f"Level: {issue_data['level']}\n"
                   f"First Seen: {issue_data['firstSeen']}\n"
                   f"Last Seen: {issue_data['lastSeen']}\n"
                   f"Count: {issue_data['count']}")
        else:
            return f"Error retrieving issue details: {response.status_code}\n{response.text}"
    except Exception as e:
        return f"Exception occurred: {str(e)}"

@mcp.tool()
async def sentry_list_all_org_issues(limit: int = 10) -> str:
    """List recent issues from your Sentry organization.
    Args:
        limit: Maximum number of issues to return (default: 10)
    Returns:
        str: List of issues with their IDs and titles
    """
    url = f"https://sentry.io/api/0/organizations/{ORGANIZATION_ID}/issues/"
    headers = {
        "Authorization": f"Bearer {AUTH_TOKEN}"
    }
    params = {"limit": limit}

    try:
        response = requests.get(url, headers=headers, params=params)
        if response.status_code == 200:
            issues = response.json()
            if not issues:
                return "No issues found."
            
            result = "Recent Issues:\n"
            for issue in issues:
                result += f"ID: {issue['id']} - {issue['title']}\n"
            return result
        else:
            return f"Error retrieving issues: {response.status_code}\n{response.text}"
    except Exception as e:
        return f"Exception occurred: {str(e)}"

if __name__ == "__main__":
    try:
        mcp.run(transport='stdio')
    except Exception as e:
        print(f"Error starting server: {e}")
        sys.exit(1)
