import { z } from "zod";

export const NeoConfigSchema = z.object({
  telegram: z.object({
    botToken: z.string(),
    allowedUsers: z.array(z.number()),
    allowedGroups: z.array(z.number()).default([]),
    pollingMode: z.boolean().default(true),
  }),
  claude: z.object({
    authMethod: z.enum(["oauth", "api-key"]).default("oauth"),
    oauthToken: z.string().optional(),
    apiKey: z.string().optional(),
    defaultModel: z.string().default("sonnet"),
    maxBudgetUsd: z.number().default(5.0),
    maxTurns: z.number().default(25),
  }),
  mcp: z
    .object({
      enabled: z.record(z.string(), z.boolean()).default({}),
      configs: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    })
    .default({}),
  docker: z
    .object({
      imageName: z.string().default("neo-agent"),
      memoryLimit: z.string().default("2g"),
      cpuLimit: z.string().default("2"),
      workspacePath: z.string().default("/workspace"),
    })
    .default({}),
  database: z
    .object({
      path: z.string().default("./data/neo.db"),
    })
    .default({}),
  security: z
    .object({
      auditLog: z.boolean().default(true),
      maxConcurrentAgents: z.number().default(3),
      toolDenyList: z.array(z.string()).default([]),
    })
    .default({}),
});

export type NeoConfig = z.infer<typeof NeoConfigSchema>;

export function loadConfig(raw: unknown): NeoConfig {
  return NeoConfigSchema.parse(raw);
}
