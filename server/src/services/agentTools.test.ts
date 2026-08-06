/**
 * The shared agent tool registry.
 *
 * This exists because there are two agent surfaces — the MCP endpoint and AI
 * Routines — and a tool defined in two places is a tool whose two definitions
 * will eventually disagree. What is worth pinning is not each handler (the
 * surfaces' own suites cover those) but the properties that keep them one thing.
 */

import { describe, expect, it } from 'vitest';
import { SCOPES } from './apiTokenService.js';
import { AGENT_TOOLS, jsonSchemaFor, toolsForScopes } from './agentTools.js';

describe('the agent tool registry', () => {
  it('names every tool once', () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every tool a scope that actually exists', () => {
    // A typo here would register a tool nobody can ever be granted.
    for (const tool of AGENT_TOOLS) {
      expect(SCOPES).toContain(tool.scope);
    }
  });

  it('offers nothing to a caller with no scopes', () => {
    expect(toolsForScopes([])).toHaveLength(0);
  });

  it('offers only the tools a scope covers', () => {
    const tools = toolsForScopes(['chat:read']);
    expect(tools.map((t) => t.name).sort()).toEqual(['list_channels', 'search_messages']);
  });

  it('withholds the attended-only tools from routines', () => {
    // A routine runs with nobody watching, so it gets the verbs that make sense
    // on a schedule. An MCP client has a person driving it and gets the rest.
    const all = toolsForScopes(SCOPES).map((t) => t.name);
    const unattended = toolsForScopes(SCOPES, { unattendedOnly: true }).map((t) => t.name);
    expect(unattended.length).toBeLessThan(all.length);
    for (const name of ['update_ticket', 'write_doc', 'write_sheet']) {
      expect(all).toContain(name);
      expect(unattended).not.toContain(name);
    }
  });

  it('derives an Anthropic-shaped schema from each zod shape', () => {
    const createTicket = AGENT_TOOLS.find((t) => t.name === 'create_ticket');
    const schema = jsonSchemaFor(createTicket!);
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties as object)).toContain('projectId');
    expect(schema.required).toContain('title');
    // The Anthropic API rejects $schema on a tool's input_schema.
    expect(schema.$schema).toBeUndefined();
  });

  it('derives a schema for every tool, including the ones taking no input', () => {
    for (const tool of AGENT_TOOLS) {
      expect(() => jsonSchemaFor(tool)).not.toThrow();
    }
  });
});
