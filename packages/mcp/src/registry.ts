import type { NeoConfig } from "@neo/core";

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export class McpRegistry {
  private configs = new Map<string, McpServerConfig>();

  constructor(private config: NeoConfig) {}

  initialize(): void {
    const enabled = this.config.mcp.enabled;
    const configs = this.config.mcp.configs;

    // ─── Filesystem & Files ──────────────────────────────────────────

    if (enabled.filesystem) {
      const paths = (configs.filesystem?.allowedPaths as string[]) ?? [];
      this.configs.set("filesystem", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", ...paths],
      });
    }

    // ─── Version Control ─────────────────────────────────────────────

    if (enabled.git) {
      this.configs.set("git", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-git"],
      });
    }

    if (enabled.github) {
      this.configs.set("github", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: configs.github?.token
          ? { GITHUB_PERSONAL_ACCESS_TOKEN: configs.github.token as string }
          : undefined,
      });
    }

    if (enabled.gitlab) {
      this.configs.set("gitlab", {
        command: "npx",
        args: ["-y", "@dubuqingfeng/gitlab-mcp-server"],
        env: configs.gitlab?.token ? { GITLAB_TOKEN: configs.gitlab.token as string } : undefined,
      });
    }

    // ─── Web & HTTP ──────────────────────────────────────────────────

    if (enabled.fetch) {
      this.configs.set("fetch", {
        command: "npx",
        args: ["-y", "@anthropic-ai/mcp-server-fetch"],
      });
    }

    if (enabled.firecrawl) {
      this.configs.set("firecrawl", {
        command: "npx",
        args: ["-y", "firecrawl-mcp"],
        env: configs.firecrawl?.apiKey
          ? { FIRECRAWL_API_KEY: configs.firecrawl.apiKey as string }
          : undefined,
      });
    }

    // ─── Web Search ──────────────────────────────────────────────────

    if (enabled["brave-search"]) {
      this.configs.set("brave-search", {
        command: "npx",
        args: ["-y", "@brave/brave-search-mcp-server"],
        env: configs["brave-search"]?.apiKey
          ? { BRAVE_API_KEY: configs["brave-search"].apiKey as string }
          : undefined,
      });
    }

    if (enabled.tavily) {
      this.configs.set("tavily", {
        command: "npx",
        args: ["-y", "tavily-mcp"],
        env: configs.tavily?.apiKey
          ? { TAVILY_API_KEY: configs.tavily.apiKey as string }
          : undefined,
      });
    }

    if (enabled.exa) {
      this.configs.set("exa", {
        command: "npx",
        args: ["-y", "exa-mcp-server"],
        env: configs.exa?.apiKey ? { EXA_API_KEY: configs.exa.apiKey as string } : undefined,
      });
    }

    if (enabled.perplexity) {
      this.configs.set("perplexity", {
        command: "npx",
        args: ["-y", "@nicepkg/mcp-server-perplexity"],
        env: configs.perplexity?.apiKey
          ? { PERPLEXITY_API_KEY: configs.perplexity.apiKey as string }
          : undefined,
      });
    }

    // ─── Thinking & Memory ───────────────────────────────────────────

    if (enabled.memory) {
      this.configs.set("memory", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
      });
    }

    if (enabled["sequential-thinking"]) {
      this.configs.set("sequential-thinking", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      });
    }

    // ─── Browser Automation ──────────────────────────────────────────

    if (enabled.puppeteer) {
      this.configs.set("puppeteer", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-puppeteer"],
      });
    }

    if (enabled.playwright) {
      this.configs.set("playwright", {
        command: "npx",
        args: ["-y", "@playwright/mcp"],
      });
    }

    if (enabled.browserbase) {
      this.configs.set("browserbase", {
        command: "npx",
        args: ["-y", "@browserbasehq/mcp"],
        env: {
          ...(configs.browserbase?.apiKey
            ? { BROWSERBASE_API_KEY: configs.browserbase.apiKey as string }
            : {}),
          ...(configs.browserbase?.projectId
            ? { BROWSERBASE_PROJECT_ID: configs.browserbase.projectId as string }
            : {}),
        },
      });
    }

    // ─── Databases: SQL ──────────────────────────────────────────────

    if (enabled.sqlite) {
      this.configs.set("sqlite", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sqlite", this.config.database.path],
      });
    }

    if (enabled.postgres) {
      this.configs.set("postgres", {
        command: "npx",
        args: [
          "-y",
          "@modelcontextprotocol/server-postgres",
          (configs.postgres?.connectionString as string) ?? "",
        ],
      });
    }

    if (enabled.mysql) {
      this.configs.set("mysql", {
        command: "npx",
        args: ["-y", "@benborla29/mcp-server-mysql"],
        env: {
          ...(configs.mysql?.host ? { MYSQL_HOST: configs.mysql.host as string } : {}),
          ...(configs.mysql?.user ? { MYSQL_USER: configs.mysql.user as string } : {}),
          ...(configs.mysql?.password ? { MYSQL_PASSWORD: configs.mysql.password as string } : {}),
          ...(configs.mysql?.database ? { MYSQL_DATABASE: configs.mysql.database as string } : {}),
        },
      });
    }

    // ─── Databases: NoSQL ────────────────────────────────────────────

    if (enabled.mongodb) {
      this.configs.set("mongodb", {
        command: "npx",
        args: [
          "-y",
          "mongodb-mcp-server",
          ...(configs.mongodb?.connectionString
            ? ["--connectionString", configs.mongodb.connectionString as string]
            : []),
        ],
      });
    }

    if (enabled.redis) {
      this.configs.set("redis", {
        command: "npx",
        args: ["-y", "@redis/mcp"],
        env: configs.redis?.url ? { REDIS_URL: configs.redis.url as string } : undefined,
      });
    }

    if (enabled.elasticsearch) {
      this.configs.set("elasticsearch", {
        command: "npx",
        args: ["-y", "@elastic/mcp-server-elasticsearch"],
        env: {
          ...(configs.elasticsearch?.url ? { ES_URL: configs.elasticsearch.url as string } : {}),
          ...(configs.elasticsearch?.apiKey
            ? { ES_API_KEY: configs.elasticsearch.apiKey as string }
            : {}),
        },
      });
    }

    // ─── Databases: Graph ────────────────────────────────────────────

    if (enabled.neo4j) {
      this.configs.set("neo4j", {
        command: "npx",
        args: ["-y", "@neo4j/mcp-neo4j"],
        env: {
          ...(configs.neo4j?.uri ? { NEO4J_URI: configs.neo4j.uri as string } : {}),
          ...(configs.neo4j?.user ? { NEO4J_USER: configs.neo4j.user as string } : {}),
          ...(configs.neo4j?.password ? { NEO4J_PASSWORD: configs.neo4j.password as string } : {}),
        },
      });
    }

    // ─── Databases: Vector ───────────────────────────────────────────

    if (enabled.qdrant) {
      this.configs.set("qdrant", {
        command: "npx",
        args: ["-y", "mcp-server-qdrant"],
        env: {
          ...(configs.qdrant?.url ? { QDRANT_URL: configs.qdrant.url as string } : {}),
          ...(configs.qdrant?.apiKey ? { QDRANT_API_KEY: configs.qdrant.apiKey as string } : {}),
        },
      });
    }

    if (enabled.chromadb) {
      this.configs.set("chromadb", {
        command: "npx",
        args: ["-y", "chroma-mcp"],
        env: configs.chromadb?.host ? { CHROMA_HOST: configs.chromadb.host as string } : undefined,
      });
    }

    if (enabled.pinecone) {
      this.configs.set("pinecone", {
        command: "npx",
        args: ["-y", "mcp-pinecone"],
        env: configs.pinecone?.apiKey
          ? { PINECONE_API_KEY: configs.pinecone.apiKey as string }
          : undefined,
      });
    }

    if (enabled.milvus) {
      this.configs.set("milvus", {
        command: "npx",
        args: ["-y", "mcp-server-milvus"],
        env: configs.milvus?.uri ? { MILVUS_URI: configs.milvus.uri as string } : undefined,
      });
    }

    if (enabled.weaviate) {
      this.configs.set("weaviate", {
        command: "npx",
        args: ["-y", "mcp-server-weaviate"],
        env: {
          ...(configs.weaviate?.url ? { WEAVIATE_URL: configs.weaviate.url as string } : {}),
          ...(configs.weaviate?.apiKey
            ? { WEAVIATE_API_KEY: configs.weaviate.apiKey as string }
            : {}),
        },
      });
    }

    // ─── Containers & Orchestration ──────────────────────────────────

    if (enabled.docker) {
      this.configs.set("docker", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-docker"],
      });
    }

    if (enabled.kubernetes) {
      this.configs.set("kubernetes", {
        command: "npx",
        args: ["-y", "mcp-server-kubernetes"],
      });
    }

    // ─── Cloud Providers ─────────────────────────────────────────────

    if (enabled.aws) {
      this.configs.set("aws", {
        command: "npx",
        args: ["-y", "@awslabs/mcp"],
        env: {
          ...(configs.aws?.region ? { AWS_REGION: configs.aws.region as string } : {}),
          ...(configs.aws?.profile ? { AWS_PROFILE: configs.aws.profile as string } : {}),
        },
      });
    }

    if (enabled.cloudflare) {
      this.configs.set("cloudflare", {
        command: "npx",
        args: ["-y", "mcp-server-cloudflare"],
        env: configs.cloudflare?.apiToken
          ? { CLOUDFLARE_API_TOKEN: configs.cloudflare.apiToken as string }
          : undefined,
      });
    }

    // ─── Infrastructure as Code ──────────────────────────────────────

    if (enabled.terraform) {
      this.configs.set("terraform", {
        command: "npx",
        args: ["-y", "terraform-mcp-server"],
      });
    }

    // ─── Monitoring & Observability ──────────────────────────────────

    if (enabled.grafana) {
      this.configs.set("grafana", {
        command: "npx",
        args: ["-y", "mcp-grafana"],
        env: {
          ...(configs.grafana?.url ? { GRAFANA_URL: configs.grafana.url as string } : {}),
          ...(configs.grafana?.apiKey ? { GRAFANA_API_KEY: configs.grafana.apiKey as string } : {}),
        },
      });
    }

    if (enabled.sentry) {
      this.configs.set("sentry", {
        command: "npx",
        args: ["-y", "@sentry/mcp-server"],
        env: configs.sentry?.authToken
          ? { SENTRY_AUTH_TOKEN: configs.sentry.authToken as string }
          : undefined,
      });
    }

    if (enabled.prometheus) {
      this.configs.set("prometheus", {
        command: "npx",
        args: ["-y", "mcp-server-prometheus"],
        env: configs.prometheus?.url
          ? { PROMETHEUS_URL: configs.prometheus.url as string }
          : undefined,
      });
    }

    // ─── Code Quality & Development ──────────────────────────────────

    if (enabled.eslint) {
      this.configs.set("eslint", {
        command: "npx",
        args: ["-y", "@eslint/mcp"],
      });
    }

    if (enabled.semgrep) {
      this.configs.set("semgrep", {
        command: "npx",
        args: ["-y", "semgrep-mcp"],
      });
    }

    if (enabled.context7) {
      this.configs.set("context7", {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      });
    }

    // ─── Deployment Platforms ────────────────────────────────────────

    if (enabled.vercel) {
      this.configs.set("vercel", {
        command: "npx",
        args: ["-y", "mcp-server-vercel"],
        env: configs.vercel?.token ? { VERCEL_TOKEN: configs.vercel.token as string } : undefined,
      });
    }

    if (enabled.netlify) {
      this.configs.set("netlify", {
        command: "npx",
        args: ["-y", "@netlify/mcp"],
        env: configs.netlify?.token
          ? { NETLIFY_AUTH_TOKEN: configs.netlify.token as string }
          : undefined,
      });
    }

    // ─── Security ────────────────────────────────────────────────────

    if (enabled.snyk) {
      this.configs.set("snyk", {
        command: "npx",
        args: ["-y", "snyk-mcp"],
        env: configs.snyk?.token ? { SNYK_TOKEN: configs.snyk.token as string } : undefined,
      });
    }

    // ─── Communication: Chat & Messaging ─────────────────────────────

    if (enabled.slack) {
      this.configs.set("slack", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-slack"],
        env: configs.slack?.botToken
          ? { SLACK_BOT_TOKEN: configs.slack.botToken as string }
          : undefined,
      });
    }

    if (enabled.discord) {
      this.configs.set("discord", {
        command: "npx",
        args: ["-y", "mcp-discord"],
        env: configs.discord?.botToken
          ? { DISCORD_BOT_TOKEN: configs.discord.botToken as string }
          : undefined,
      });
    }

    if (enabled.twitter) {
      this.configs.set("twitter", {
        command: "npx",
        args: ["-y", "@barresider/x-mcp"],
        env: {
          ...(configs.twitter?.apiKey ? { TWITTER_API_KEY: configs.twitter.apiKey as string } : {}),
          ...(configs.twitter?.apiSecret
            ? { TWITTER_API_SECRET: configs.twitter.apiSecret as string }
            : {}),
          ...(configs.twitter?.accessToken
            ? { TWITTER_ACCESS_TOKEN: configs.twitter.accessToken as string }
            : {}),
          ...(configs.twitter?.accessTokenSecret
            ? { TWITTER_ACCESS_TOKEN_SECRET: configs.twitter.accessTokenSecret as string }
            : {}),
        },
      });
    }

    if (enabled.whatsapp) {
      this.configs.set("whatsapp", {
        command: "npx",
        args: ["-y", "whatsapp-mcp"],
        env: configs.whatsapp?.token
          ? { WHATSAPP_TOKEN: configs.whatsapp.token as string }
          : undefined,
      });
    }

    // ─── Communication: Email ────────────────────────────────────────

    if (enabled.email) {
      this.configs.set("email", {
        command: "npx",
        args: ["-y", "email-mcp"],
        env: {
          ...(configs.email?.imapHost ? { IMAP_HOST: configs.email.imapHost as string } : {}),
          ...(configs.email?.imapPort ? { IMAP_PORT: configs.email.imapPort as string } : {}),
          ...(configs.email?.smtpHost ? { SMTP_HOST: configs.email.smtpHost as string } : {}),
          ...(configs.email?.smtpPort ? { SMTP_PORT: configs.email.smtpPort as string } : {}),
          ...(configs.email?.user ? { EMAIL_USER: configs.email.user as string } : {}),
          ...(configs.email?.password ? { EMAIL_PASSWORD: configs.email.password as string } : {}),
        },
      });
    }

    // ─── Communication: Apple Ecosystem ──────────────────────────────

    if (enabled.imessage) {
      this.configs.set("imessage", {
        command: "npx",
        args: ["-y", "mac-messages-mcp"],
      });
    }

    // ─── Productivity & Notes ────────────────────────────────────────

    if (enabled.notion) {
      this.configs.set("notion", {
        command: "npx",
        args: ["-y", "notion-mcp"],
        env: configs.notion?.apiKey
          ? { NOTION_API_KEY: configs.notion.apiKey as string }
          : undefined,
      });
    }

    if (enabled["google-workspace"]) {
      this.configs.set("google-workspace", {
        command: "npx",
        args: ["-y", "mcp-google-workspace"],
        env: configs["google-workspace"]?.credentialsPath
          ? {
              GOOGLE_CREDENTIALS_PATH: configs["google-workspace"].credentialsPath as string,
            }
          : undefined,
      });
    }

    if (enabled.linear) {
      this.configs.set("linear", {
        command: "npx",
        args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
        env: configs.linear?.apiKey
          ? { LINEAR_API_KEY: configs.linear.apiKey as string }
          : undefined,
      });
    }

    if (enabled.todoist) {
      this.configs.set("todoist", {
        command: "npx",
        args: ["-y", "todoist-mcp-server"],
        env: configs.todoist?.apiToken
          ? { TODOIST_API_TOKEN: configs.todoist.apiToken as string }
          : undefined,
      });
    }

    if (enabled.obsidian) {
      this.configs.set("obsidian", {
        command: "npx",
        args: [
          "-y",
          "obsidian-mcp",
          ...(configs.obsidian?.vaultPath ? [configs.obsidian.vaultPath as string] : []),
        ],
      });
    }

    if (enabled["google-calendar"]) {
      this.configs.set("google-calendar", {
        command: "npx",
        args: ["-y", "mcp-server-google-calendar"],
        env: configs["google-calendar"]?.credentialsPath
          ? {
              GOOGLE_CREDENTIALS_PATH: configs["google-calendar"].credentialsPath as string,
            }
          : undefined,
      });
    }

    if (enabled.trello) {
      this.configs.set("trello", {
        command: "npx",
        args: ["-y", "mcp-server-trello"],
        env: {
          ...(configs.trello?.apiKey ? { TRELLO_API_KEY: configs.trello.apiKey as string } : {}),
          ...(configs.trello?.token ? { TRELLO_TOKEN: configs.trello.token as string } : {}),
        },
      });
    }

    if (enabled.jira) {
      this.configs.set("jira", {
        command: "npx",
        args: ["-y", "mcp-server-jira"],
        env: {
          ...(configs.jira?.url ? { JIRA_URL: configs.jira.url as string } : {}),
          ...(configs.jira?.email ? { JIRA_EMAIL: configs.jira.email as string } : {}),
          ...(configs.jira?.apiToken ? { JIRA_API_TOKEN: configs.jira.apiToken as string } : {}),
        },
      });
    }

    // ─── Smart Home & IoT ────────────────────────────────────────────

    if (enabled["home-assistant"]) {
      this.configs.set("home-assistant", {
        command: "npx",
        args: ["-y", "homeassistant-mcp"],
        env: configs["home-assistant"]?.token
          ? { HA_TOKEN: configs["home-assistant"].token as string }
          : undefined,
      });
    }

    // ─── Data Analysis & Code Execution ──────────────────────────────

    if (enabled.jupyter) {
      this.configs.set("jupyter", {
        command: "npx",
        args: ["-y", "jupyter-mcp-server"],
        env: configs.jupyter?.url
          ? { JUPYTER_SERVER_URL: configs.jupyter.url as string }
          : undefined,
      });
    }

    if (enabled.e2b) {
      this.configs.set("e2b", {
        command: "npx",
        args: ["-y", "@e2b/mcp-server"],
        env: configs.e2b?.apiKey ? { E2B_API_KEY: configs.e2b.apiKey as string } : undefined,
      });
    }

    // ─── Academic Research ───────────────────────────────────────────

    if (enabled["paper-search"]) {
      this.configs.set("paper-search", {
        command: "npx",
        args: ["-y", "paper-search-mcp"],
      });
    }

    if (enabled.arxiv) {
      this.configs.set("arxiv", {
        command: "npx",
        args: ["-y", "arxiv-mcp-server"],
      });
    }

    // ─── Social Media & Content ──────────────────────────────────────

    if (enabled["hacker-news"]) {
      this.configs.set("hacker-news", {
        command: "npx",
        args: ["-y", "mcp-hacker-news"],
      });
    }

    if (enabled.reddit) {
      this.configs.set("reddit", {
        command: "npx",
        args: ["-y", "mcp-reddit"],
        env: {
          ...(configs.reddit?.clientId
            ? { REDDIT_CLIENT_ID: configs.reddit.clientId as string }
            : {}),
          ...(configs.reddit?.clientSecret
            ? { REDDIT_CLIENT_SECRET: configs.reddit.clientSecret as string }
            : {}),
        },
      });
    }

    if (enabled["youtube-transcript"]) {
      this.configs.set("youtube-transcript", {
        command: "npx",
        args: ["-y", "mcp-server-youtube-transcript"],
      });
    }

    // ─── macOS Native ────────────────────────────────────────────────

    if (enabled["apple-shortcuts"]) {
      this.configs.set("apple-shortcuts", {
        command: "npx",
        args: ["-y", "mcp-server-apple-shortcuts"],
      });
    }

    if (enabled["apple-reminders"]) {
      this.configs.set("apple-reminders", {
        command: "npx",
        args: ["-y", "mcp-server-apple-reminders"],
      });
    }

    if (enabled["apple-notes"]) {
      this.configs.set("apple-notes", {
        command: "npx",
        args: ["-y", "apple-notes-mcp"],
      });
    }

    if (enabled["apple-health"]) {
      this.configs.set("apple-health", {
        command: "npx",
        args: ["-y", "apple-health-mcp-server"],
      });
    }

    // ─── Maps & Location ─────────────────────────────────────────────

    if (enabled["google-maps"]) {
      this.configs.set("google-maps", {
        command: "npx",
        args: ["-y", "@googlemaps/code-assist-mcp"],
        env: configs["google-maps"]?.apiKey
          ? { GOOGLE_MAPS_API_KEY: configs["google-maps"].apiKey as string }
          : undefined,
      });
    }

    // ─── Utilities ───────────────────────────────────────────────────

    if (enabled.time) {
      this.configs.set("time", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-time"],
      });
    }

    // ─── Image & Media Generation ────────────────────────────────────

    if (enabled["stability-ai"]) {
      this.configs.set("stability-ai", {
        command: "npx",
        args: ["-y", "mcp-server-stability-ai"],
        env: configs["stability-ai"]?.apiKey
          ? { STABILITY_API_KEY: configs["stability-ai"].apiKey as string }
          : undefined,
      });
    }

    if (enabled["dall-e"]) {
      this.configs.set("dall-e", {
        command: "npx",
        args: ["-y", "mcp-server-dall-e"],
        env: configs["dall-e"]?.apiKey
          ? { OPENAI_API_KEY: configs["dall-e"].apiKey as string }
          : undefined,
      });
    }

    // ─── Workflow Automation ─────────────────────────────────────────

    if (enabled.n8n) {
      this.configs.set("n8n", {
        command: "npx",
        args: ["-y", "n8n-mcp"],
        env: configs.n8n?.url ? { N8N_URL: configs.n8n.url as string } : undefined,
      });
    }

    // ─── Data Aggregators ────────────────────────────────────────────

    if (enabled.anyquery) {
      this.configs.set("anyquery", {
        command: "npx",
        args: ["-y", "anyquery-mcp"],
      });
    }

    // ─── File Conversion & Processing ────────────────────────────────

    if (enabled.markitdown) {
      this.configs.set("markitdown", {
        command: "npx",
        args: ["-y", "mcp-server-markitdown"],
      });
    }

    if (enabled.pandoc) {
      this.configs.set("pandoc", {
        command: "npx",
        args: ["-y", "mcp-server-pandoc"],
      });
    }

    // ─── Cloud Storage ───────────────────────────────────────────────

    if (enabled.s3) {
      this.configs.set("s3", {
        command: "npx",
        args: ["-y", "mcp-server-s3"],
        env: {
          ...(configs.s3?.region ? { AWS_REGION: configs.s3.region as string } : {}),
          ...(configs.s3?.bucket ? { S3_BUCKET: configs.s3.bucket as string } : {}),
        },
      });
    }

    if (enabled["google-drive"]) {
      this.configs.set("google-drive", {
        command: "npx",
        args: ["-y", "@anthropic-ai/mcp-server-google-drive"],
        env: configs["google-drive"]?.credentialsPath
          ? {
              GOOGLE_CREDENTIALS_PATH: configs["google-drive"].credentialsPath as string,
            }
          : undefined,
      });
    }

    // ─── CI/CD ───────────────────────────────────────────────────────

    if (enabled["github-actions"]) {
      this.configs.set("github-actions", {
        command: "npx",
        args: ["-y", "mcp-server-github-actions"],
        env: configs["github-actions"]?.token
          ? { GITHUB_TOKEN: configs["github-actions"].token as string }
          : undefined,
      });
    }

    // ─── DNS & Networking ────────────────────────────────────────────

    if (enabled.nmap) {
      this.configs.set("nmap", {
        command: "npx",
        args: ["-y", "nmap-mcp-server"],
      });
    }

    // ─── CMS & Websites ─────────────────────────────────────────────

    if (enabled.wordpress) {
      this.configs.set("wordpress", {
        command: "npx",
        args: ["-y", "mcp-server-wordpress"],
        env: {
          ...(configs.wordpress?.url ? { WP_URL: configs.wordpress.url as string } : {}),
          ...(configs.wordpress?.username
            ? { WP_USERNAME: configs.wordpress.username as string }
            : {}),
          ...(configs.wordpress?.password
            ? { WP_PASSWORD: configs.wordpress.password as string }
            : {}),
        },
      });
    }

    // ─── Package Managers ────────────────────────────────────────────

    if (enabled.npm) {
      this.configs.set("npm", {
        command: "npx",
        args: ["-y", "mcp-server-npm"],
      });
    }
  }

  getConfigsForAgent(_agentType: string): Record<string, McpServerConfig> {
    // For now, all agents get all configs. Can be refined per-agent later.
    return Object.fromEntries(this.configs);
  }

  getActiveConfigs(): Record<string, McpServerConfig> {
    return Object.fromEntries(this.configs);
  }

  getServerNames(): string[] {
    return [...this.configs.keys()];
  }
}
