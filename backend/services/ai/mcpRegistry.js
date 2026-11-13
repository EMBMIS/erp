/**
 * Catalogue of connectable MCP servers.
 *
 * Everything in this list is a REMOTE server Simeli can connect to over HTTPS by
 * itself. That is the whole entry requirement, and it is deliberate: a
 * connector list exists to be clicked, so an entry that cannot be connected —
 * one that asks the reader to install and run a program on their own machine —
 * does not belong in it, however popular the underlying product is.
 *
 * Google Drive is the instructive case. It is a first-class connector in
 * desktop AI apps, but those apps ship their own private integration; Google
 * publishes no public MCP endpoint, and the community server is a local npm
 * package. Listing it here with an install command would put a button in front
 * of someone that cannot do anything. It is therefore absent, and the honest
 * route to Google Workspace is the Zapier entry below, which is a real remote
 * server that reaches Drive, Sheets and Gmail.
 *
 * Local/stdio servers are still handled — just not here. When a web search
 * turns one up, services/ai/mcpEndpoint.js extracts the vendor's own install
 * command and shows it as instructions, which is the truthful thing to do with
 * something this system cannot run (see the local-sandboxing note in
 * services/ai/mcpConnections.js).
 *
 *   auth: 'oauth'   sign in with the provider; no key to paste, and dynamic
 *                   client registration means nothing to pre-register either.
 *   auth: 'api_key' paste a key, encrypted into the credential vault.
 *   auth: 'none'    open server, connects immediately.
 *
 * Every endpoint below has been confirmed reachable by actually connecting to
 * it — `npm run mcp:verify` re-checks them, because vendors move endpoints and
 * a list that is not re-checked quietly rots.
 */

const REGISTRY = [
  // --- Payments & finance ---------------------------------------------------
  {
    name: 'Stripe',
    description: 'Payments, customers, subscriptions, invoices and refunds through the Stripe API.',
    category: 'Payments', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.stripe.com',
    url_or_package: 'https://docs.stripe.com/mcp',
    tools_preview: ['create_payment_intent', 'list_customers', 'create_invoice', 'create_refund', 'list_subscriptions'],
  },
  {
    name: 'PayPal',
    description: 'Invoices, orders, payments, disputes and subscriptions in PayPal.',
    category: 'Payments', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.paypal.com/mcp',
    url_or_package: 'https://www.paypal.ai/docs/tools/mcp-quickstart',
    tools_preview: ['create_invoice', 'list_transactions', 'create_order', 'list_disputes'],
  },
  {
    name: 'Square',
    description: 'Payments, orders, catalog, inventory and customers for Square sellers.',
    category: 'Payments', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.squareup.com/sse',
    url_or_package: 'https://developer.squareup.com/docs/mcp',
    tools_preview: ['create_payment', 'list_orders', 'update_catalog', 'list_customers'],
  },
  {
    name: 'Dodo Payments',
    description: 'Merchant-of-record billing: payments, subscriptions, licence keys and payouts.',
    category: 'Payments', auth: 'api_key', erp: true,
    endpoint_url: 'https://mcp.dodopayments.com/sse',
    url_or_package: 'https://docs.dodopayments.com/developer-resources/mcp-server',
    tools_preview: ['create_payment', 'list_subscriptions', 'create_refund'],
  },

  // --- CRM, sales & support -------------------------------------------------
  {
    name: 'HubSpot',
    description: 'Contacts, companies, deals and engagements in the HubSpot CRM.',
    category: 'CRM', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.hubspot.com/anthropic',
    url_or_package: 'https://developers.hubspot.com/mcp',
    tools_preview: ['search_crm_objects', 'create_contact', 'update_deal', 'list_engagements'],
  },
  {
    name: 'Close CRM',
    description: 'Leads, opportunities, calls and sequences in Close.',
    category: 'CRM', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.close.com/mcp',
    url_or_package: 'https://developer.close.com/resources/mcp-server/',
    tools_preview: ['search_leads', 'create_opportunity', 'log_activity'],
  },
  {
    name: 'Intercom',
    description: 'Conversations, contacts and help-centre content in Intercom.',
    category: 'Support', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.intercom.com/sse',
    url_or_package: 'https://developers.intercom.com/docs/guides/mcp',
    tools_preview: ['search_conversations', 'get_contact', 'reply_to_conversation'],
  },

  // --- Commerce -------------------------------------------------------------
  {
    name: 'Shopify Dev',
    description: 'Shopify Admin and Storefront API schemas and documentation for building against a store.',
    category: 'E-commerce', auth: 'oauth', erp: true,
    endpoint_url: 'https://shopify.dev/mcp',
    url_or_package: 'https://shopify.dev/docs/apps/build/devmcp',
    tools_preview: ['search_dev_docs', 'introspect_admin_schema', 'fetch_docs_by_path'],
  },
  {
    name: 'Wix',
    description: 'Stores, bookings, CMS collections and site content on Wix.',
    category: 'E-commerce', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.wix.com/sse',
    url_or_package: 'https://dev.wix.com/docs/mcp',
    tools_preview: ['list_products', 'manage_orders', 'query_collections'],
  },
  {
    name: 'Webflow',
    description: 'CMS collections, items and site publishing on Webflow.',
    category: 'E-commerce', auth: 'oauth', erp: false,
    endpoint_url: 'https://mcp.webflow.com/sse',
    url_or_package: 'https://developers.webflow.com/data/docs/ai-tools',
    tools_preview: ['list_collections', 'create_item', 'publish_site'],
  },

  // --- Work management ------------------------------------------------------
  {
    name: 'Linear',
    description: 'Issues, projects, cycles and comments in Linear.',
    category: 'Project management', auth: 'oauth', erp: false,
    endpoint_url: 'https://mcp.linear.app/mcp',
    url_or_package: 'https://linear.app/docs/mcp',
    tools_preview: ['create_issue', 'list_issues', 'update_issue', 'list_projects'],
  },
  {
    name: 'Atlassian (Jira & Confluence)',
    description: 'Jira issues and Confluence pages from Atlassian Cloud.',
    category: 'Project management', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.atlassian.com/v1/sse',
    url_or_package: 'https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/',
    tools_preview: ['createJiraIssue', 'searchJiraIssuesUsingJql', 'getConfluencePage'],
  },
  {
    name: 'Asana',
    description: 'Tasks, projects, portfolios and workspaces in Asana.',
    category: 'Project management', auth: 'oauth', erp: false,
    endpoint_url: 'https://mcp.asana.com/sse',
    url_or_package: 'https://developers.asana.com/docs/mcp-server',
    tools_preview: ['create_task', 'search_tasks', 'list_projects'],
  },
  {
    name: 'monday.com',
    description: 'Boards, items and updates in monday.com.',
    category: 'Project management', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.monday.com/sse',
    url_or_package: 'https://developer.monday.com/apps/docs/mondaycom-mcp-integration',
    tools_preview: ['create_item', 'query_board', 'update_item'],
  },
  {
    name: 'Jam',
    description: 'Bug reports with session replay, console logs and network traces.',
    category: 'Project management', auth: 'oauth', erp: false,
    endpoint_url: 'https://mcp.jam.dev/mcp',
    url_or_package: 'https://jam.dev/docs/debug-a-jam/mcp',
    tools_preview: ['get_jam', 'list_jams'],
  },

  // --- Documents & productivity --------------------------------------------
  {
    name: 'Notion',
    description: 'Pages, databases and workspace search in Notion.',
    category: 'Productivity', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.notion.com/mcp',
    url_or_package: 'https://developers.notion.com/docs/mcp',
    tools_preview: ['search', 'fetch', 'create_pages', 'update_page'],
  },
  {
    name: 'Box',
    description: 'Search, read and manage documents stored in Box.',
    category: 'Productivity', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.box.com/',
    url_or_package: 'https://developer.box.com/guides/box-mcp/remote/',
    tools_preview: ['search_files', 'read_file', 'list_folder'],
  },
  {
    name: 'Airtable',
    description: 'Bases, tables and records in Airtable.',
    category: 'Data', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.airtable.com/mcp',
    url_or_package: 'https://support.airtable.com/docs/airtable-mcp-server',
    tools_preview: ['list_bases', 'list_records', 'create_record', 'update_record'],
  },
  {
    name: 'Canva',
    description: 'Designs, brand templates and exports in Canva.',
    category: 'Productivity', auth: 'oauth', erp: false,
    endpoint_url: 'https://mcp.canva.com/mcp',
    url_or_package: 'https://www.canva.dev/docs/apps/mcp-server/',
    tools_preview: ['search_designs', 'create_design', 'export_design'],
  },
  {
    name: 'Figma',
    description: 'Design files, components and dev-mode specifications in Figma.',
    category: 'Productivity', auth: 'oauth', erp: false,
    endpoint_url: 'https://mcp.figma.com/mcp',
    url_or_package: 'https://help.figma.com/hc/en-us/articles/32132100833559',
    tools_preview: ['get_file', 'get_code', 'get_variable_defs'],
  },
  {
    name: 'Fireflies',
    description: 'Meeting transcripts, summaries and action items from Fireflies.ai.',
    category: 'Productivity', auth: 'api_key', erp: false,
    endpoint_url: 'https://api.fireflies.ai/mcp',
    url_or_package: 'https://docs.fireflies.ai/mcp/quickstart',
    tools_preview: ['search_transcripts', 'get_summary', 'list_meetings'],
  },
  {
    name: 'Audioscrape',
    description: 'Search and transcribe audio and podcast content.',
    category: 'Productivity', auth: 'oauth', erp: false,
    endpoint_url: 'https://mcp.audioscrape.com',
    url_or_package: 'https://audioscrape.com',
    tools_preview: ['search_audio', 'get_transcript'],
  },

  // --- Developer & infrastructure ------------------------------------------
  {
    name: 'GitHub',
    description: 'Repositories, issues, pull requests, code search and Actions on GitHub.',
    category: 'Developer tools', auth: 'oauth', erp: false,
    endpoint_url: 'https://api.githubcopilot.com/mcp/',
    url_or_package: 'https://github.com/github/github-mcp-server',
    tools_preview: ['create_issue', 'search_repositories', 'get_pull_request', 'create_pull_request'],
  },
  {
    name: 'Sentry',
    description: 'Errors, issues and releases from Sentry, with Seer root-cause analysis.',
    category: 'Developer tools', auth: 'oauth', erp: false,
    endpoint_url: 'https://mcp.sentry.dev/mcp',
    url_or_package: 'https://docs.sentry.io/product/sentry-mcp/',
    tools_preview: ['find_issues', 'get_issue_details', 'analyze_issue_with_seer'],
  },
  {
    name: 'Grafana',
    description: 'Dashboards, datasources, alerts and Prometheus/Loki queries in Grafana.',
    category: 'Infrastructure', auth: 'oauth', erp: false,
    endpoint_url: 'https://mcp.grafana.com/mcp',
    url_or_package: 'https://github.com/grafana/mcp-grafana',
    tools_preview: ['search_dashboards', 'query_prometheus', 'list_alert_rules'],
  },
  {
    name: 'Cloudflare Documentation',
    description: 'Search Cloudflare’s product documentation and reference material.',
    category: 'Infrastructure', auth: 'none', erp: false,
    endpoint_url: 'https://docs.mcp.cloudflare.com/mcp',
    url_or_package: 'https://github.com/cloudflare/mcp-server-cloudflare',
    tools_preview: ['search_cloudflare_documentation', 'migrate_pages_to_workers_guide'],
  },
  {
    name: 'Cloudflare Workers Bindings',
    description: 'Manage Workers, KV, R2, D1 and other bindings on a Cloudflare account.',
    category: 'Infrastructure', auth: 'oauth', erp: false,
    endpoint_url: 'https://bindings.mcp.cloudflare.com/sse',
    url_or_package: 'https://github.com/cloudflare/mcp-server-cloudflare',
    tools_preview: ['workers_list', 'kv_namespaces_list', 'r2_buckets_list', 'd1_databases_list'],
  },
  {
    name: 'Neon',
    description: 'Serverless Postgres: projects, branches and SQL against a Neon database.',
    category: 'Data', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.neon.tech/mcp',
    url_or_package: 'https://neon.com/docs/ai/neon-mcp-server',
    tools_preview: ['list_projects', 'run_sql', 'create_branch', 'describe_table_schema'],
  },
  {
    name: 'Vercel',
    description: 'Projects, deployments and build logs on Vercel.',
    category: 'Infrastructure', auth: 'oauth', erp: false,
    endpoint_url: 'https://mcp.vercel.com',
    url_or_package: 'https://vercel.com/docs/mcp/vercel-mcp',
    tools_preview: ['list_projects', 'get_deployment', 'get_deployment_build_logs'],
  },
  {
    name: 'Stytch',
    description: 'Authentication, users, sessions and organisations in Stytch.',
    category: 'Infrastructure', auth: 'oauth', erp: false,
    endpoint_url: 'https://mcp.stytch.dev/mcp',
    url_or_package: 'https://stytch.com/docs/workspace-management/mcp-server',
    tools_preview: ['search_users', 'get_project', 'list_organizations'],
  },
  {
    name: 'Semgrep',
    description: 'Scan code for security vulnerabilities with Semgrep rules.',
    category: 'Developer tools', auth: 'none', erp: false,
    endpoint_url: 'https://mcp.semgrep.ai/mcp',
    url_or_package: 'https://github.com/semgrep/mcp',
    tools_preview: ['semgrep_scan', 'get_supported_languages', 'security_check'],
  },
  {
    name: 'Hugging Face',
    description: 'Models, datasets, Spaces and papers on the Hugging Face Hub.',
    category: 'AI', auth: 'oauth', erp: false,
    endpoint_url: 'https://huggingface.co/mcp',
    url_or_package: 'https://huggingface.co/settings/mcp',
    tools_preview: ['hf_whoami', 'hub_repo_search', 'hub_repo_details', 'hf_fs'],
  },
  {
    name: 'DeepWiki',
    description: 'AI-generated documentation and Q&A for any public GitHub repository.',
    category: 'Developer tools', auth: 'none', erp: false,
    endpoint_url: 'https://mcp.deepwiki.com/mcp',
    url_or_package: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    tools_preview: ['ask_question', 'read_wiki_contents', 'read_wiki_structure'],
  },
  {
    name: 'Context7',
    description: 'Up-to-date documentation and code examples for thousands of libraries.',
    category: 'Developer tools', auth: 'none', erp: false,
    endpoint_url: 'https://mcp.context7.com/mcp',
    url_or_package: 'https://context7.com/',
    tools_preview: ['resolve-library-id', 'query-docs'],
  },
  {
    name: 'GitMCP',
    description: 'Turns any public GitHub repository into a documentation source you can query.',
    category: 'Developer tools', auth: 'none', erp: false,
    endpoint_url: 'https://gitmcp.io/docs',
    url_or_package: 'https://gitmcp.io/',
    tools_preview: ['fetch_generic_documentation', 'search_generic_code', 'search_generic_documentation'],
  },
  {
    name: 'Globalping',
    description: 'Run ping, traceroute, DNS and HTTP checks from probes around the world.',
    category: 'Infrastructure', auth: 'oauth', erp: false,
    endpoint_url: 'https://mcp.globalping.dev/sse',
    url_or_package: 'https://github.com/jsdelivr/globalping-mcp-server',
    tools_preview: ['ping', 'traceroute', 'dns', 'http'],
  },

  // --- Search, data & web ---------------------------------------------------
  {
    name: 'Exa',
    description: 'Neural web search built for AI, with full page contents and company research.',
    category: 'Search', auth: 'api_key', erp: true,
    endpoint_url: 'https://mcp.exa.ai/mcp',
    url_or_package: 'https://docs.exa.ai/reference/exa-mcp',
    tools_preview: ['web_search_exa', 'web_fetch_exa'],
  },
  {
    name: 'Browserbase',
    description: 'Drive a real cloud browser: navigate pages, act, extract and screenshot.',
    category: 'Automation', auth: 'none', erp: true,
    endpoint_url: 'https://mcp.browserbase.com/mcp',
    url_or_package: 'https://docs.browserbase.com/integrations/mcp/introduction',
    tools_preview: ['start', 'navigate', 'act', 'extract', 'screenshot'],
  },
  {
    name: 'Simplescraper',
    description: 'Scrape any website to structured data without writing selectors.',
    category: 'Search', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.simplescraper.io/mcp',
    url_or_package: 'https://simplescraper.io/docs/mcp',
    tools_preview: ['scrape_url', 'run_recipe'],
  },
  {
    name: 'Apify',
    description: 'Run any of thousands of Apify actors for scraping and data extraction.',
    category: 'Automation', auth: 'api_key', erp: false,
    endpoint_url: 'https://mcp.apify.com',
    url_or_package: 'https://docs.apify.com/platform/integrations/mcp',
    tools_preview: ['search_actors', 'call_actor', 'get_dataset_items'],
  },
  {
    // The practical answer for Google Workspace, Slack, Xero and the many other
    // products with no public MCP server of their own: one remote connection
    // that brokers thousands of apps.
    name: 'Zapier',
    description: 'Reach thousands of apps — including Google Drive, Sheets, Gmail, Slack and Xero — through one hosted connection.',
    category: 'Automation', auth: 'oauth', erp: true,
    endpoint_url: 'https://mcp.zapier.com/api/mcp/mcp',
    url_or_package: 'https://zapier.com/mcp',
    tools_preview: ['run_action', 'search_actions'],
  },
];

/** The ERP-relevant subset, surfaced first when browsing. */
const ERP_REGISTRY = REGISTRY.filter((r) => r.erp);

const CATEGORIES = [...new Set(REGISTRY.map((r) => r.category))].sort();

module.exports = { REGISTRY, ERP_REGISTRY, CATEGORIES };
