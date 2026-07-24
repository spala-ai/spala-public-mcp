# Spala Public MCP on Postman

This bundle is the source for Spala's public Postman API Network workspace.

## Contents

- `Spala-Public-MCP.postman_collection.json`: curated discovery-to-first-success collection.
- `Spala-Public-MCP.postman_environment.json`: public defaults and an empty secret token placeholder.

## Public workspace copy

Name: `Spala Public MCP`

Summary:

> Discover Spala, inspect its MCP and OAuth contracts, and reach a successful public tool call.

Description:

> Spala is a hosted backend builder for AI-built applications. This workspace documents the public MCP front door used for discovery, OAuth, project operations, and exact project MCP handoff. Start with the four-request quickstart. Public requests need no account; protected project requests require OAuth. Backend construction and operation happen through the selected project's MCP.

## Publication checks

1. Import the collection and environment.
2. Confirm the environment contains no current bearer value.
3. Run the `First successful call` folder and require every test to pass.
4. Confirm collection variables point only to `https://mcp.spala.ai`.
5. Make the workspace public.
6. Publish the collection documentation.
7. Record the public workspace and documentation URLs in the distribution tracker.

Do not add dashboard credentials, bearer values, authorization codes, refresh
tokens, bootstrap URLs, private repository links, or inferred project MCP URLs.
