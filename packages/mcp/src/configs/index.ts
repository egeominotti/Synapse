// MCP server configuration factories
// Each factory returns a McpServerConfig for a specific MCP server

export { filesystemConfig } from "./filesystem.js";
export { gitConfig } from "./git.js";
export { fetchConfig } from "./fetch.js";
export { githubConfig } from "./github.js";
export { sqliteConfig } from "./sqlite.js";
export { postgresConfig } from "./postgres.js";
