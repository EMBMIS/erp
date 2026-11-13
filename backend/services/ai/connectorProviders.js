/**
 * The products this ERP can connect to directly.
 *
 * Not MCP. These are ordinary OAuth 2.0 applications calling ordinary REST
 * APIs, which is what a "connector" in a consumer AI product actually is —
 * Google publishes no MCP server, so anything that appears to connect to Drive
 * registered a Google Cloud OAuth app and called the Drive API. This file is
 * the equivalent: the endpoints, scopes and API base for each provider, plus
 * the named tools worth giving the assistant.
 *
 * WHAT THE OPERATOR MUST DO, AND WHY IT CANNOT BE AVOIDED
 * Each provider requires an OAuth client id and secret, created in that
 * vendor's own developer console by someone who controls the account. No
 * product can ship those on your behalf — an OAuth app identifies *who is
 * asking*, and a shared one would mean every installation impersonating the
 * same application against your data. Every AI product with a Google Drive
 * connector registered its own. So does this one; `setup_url` points at the
 * page where it is done, and `redirect_note` gives the exact callback URL to
 * paste in, because a mismatched redirect URI is the single most common reason
 * one of these fails.
 *
 * TOOLS
 * Each provider gets a generic `<key>_api_request` tool: an authenticated call
 * to any path on that provider's API. That is deliberately broad — it makes a
 * provider useful the moment it is connected, without waiting for someone to
 * hand-write a tool for every endpoint. `tools` adds named, documented
 * shortcuts for the operations people actually ask for, so the model does not
 * have to know a vendor's URL scheme to do the common thing.
 *
 * Every call made through these is treated as high-impact and requires human
 * confirmation — see services/ai/connectorTools.js. A REST call to someone's
 * real Google Drive is not something to run unattended.
 */

const PROVIDERS = {
  // --- Google ---------------------------------------------------------------
  google: {
    name: 'Google Workspace',
    description: 'Drive, Gmail, Calendar, Sheets and Docs on a Google account.',
    category: 'Productivity',
    erp: true,
    authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.googleapis.com/token',
    api_base: 'https://www.googleapis.com',
    // offline + consent is what makes Google return a refresh token; without
    // them the connection silently stops working in an hour.
    authorize_params: { access_type: 'offline', prompt: 'consent' },
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
    pkce: true,
    setup_url: 'https://console.cloud.google.com/apis/credentials',
    setup_hint: 'Create an OAuth 2.0 Client ID of type "Web application", then enable the Drive, Gmail, Calendar and Sheets APIs for the same project.',
    client_id_pattern: '\\.apps\\.googleusercontent\\.com$',
    client_id_example: '123456789012-abc123def456.apps.googleusercontent.com',
    client_secret_example: 'GOCSPX-…',
    setup_steps: [
      'Open Google Cloud Console and pick or create a project.',
      'APIs & Services → Library: enable the Google Drive API, Gmail API, Google Calendar API and Google Sheets API.',
      'APIs & Services → OAuth consent screen: set it up (External is fine), and add your own Google account under "Test users".',
      'APIs & Services → Credentials → Create credentials → OAuth client ID → Application type: Web application.',
      'Under "Authorised redirect URIs" add the callback URL shown below, then click Create.',
      'Copy the Client ID and Client secret from the dialog Google shows you, and paste them here.',
    ],
    tools: [
      {
        name: 'drive_search_files',
        description: 'Search files and folders in Google Drive by name or full-text content. Returns id, name, type and modified time.',
        method: 'GET',
        path: '/drive/v3/files',
        query: { q: '{{query}}', pageSize: '{{limit}}', fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)' },
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Drive query, e.g. \"name contains 'invoice'\" or \"fullText contains 'contract'\"" },
            limit: { type: 'number', description: 'How many files to return (default 20)' },
          },
          required: ['query'],
        },
        readOnly: true,
      },
      {
        name: 'drive_read_file',
        description: 'Download the contents of a Google Drive file as text. Use drive_search_files first to get the id.',
        method: 'GET',
        path: '/drive/v3/files/{{file_id}}',
        query: { alt: 'media' },
        input_schema: {
          type: 'object',
          properties: { file_id: { type: 'string', description: 'The Drive file id' } },
          required: ['file_id'],
        },
        readOnly: true,
      },
      {
        name: 'gmail_search_messages',
        description: 'Search Gmail messages using Gmail search syntax (e.g. "from:supplier@x.com has:attachment newer_than:7d").',
        method: 'GET',
        path: '/gmail/v1/users/me/messages',
        query: { q: '{{query}}', maxResults: '{{limit}}' },
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Gmail search query' },
            limit: { type: 'number', description: 'How many messages (default 20)' },
          },
          required: ['query'],
        },
        readOnly: true,
      },
      {
        name: 'calendar_list_events',
        description: 'List upcoming events from the primary Google Calendar.',
        method: 'GET',
        path: '/calendar/v3/calendars/primary/events',
        query: { timeMin: '{{from}}', maxResults: '{{limit}}', singleEvents: 'true', orderBy: 'startTime' },
        input_schema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'ISO timestamp to list events from (default now)' },
            limit: { type: 'number', description: 'How many events (default 20)' },
          },
        },
        readOnly: true,
      },
      {
        name: 'drive_upload_file',
        description:
          'Upload a document or artifact this ERP already generated into Google Drive (a PDF from generate_pdf_report ' +
          '/ generate_invoice_pdf / generate_custom_pdf / latex_to_pdf, or an HTML/SVG/Markdown/code artifact from ' +
          'generate_artifact). Use the document_id from that prior call — this tool reads the real stored bytes and ' +
          'uploads them with the right Drive mimeType; it cannot upload arbitrary content typed into the call. ' +
          'To upload into a specific folder, first find its id with drive_search_files ' +
          '(e.g. "name=\'Company Reports\' and mimeType=\'application/vnd.google-apps.folder\'").',
        custom: 'driveUploadFile',
        input_schema: {
          type: 'object',
          properties: {
            document_id: { type: 'string', description: 'The id returned by the tool that generated the PDF' },
            name: { type: 'string', description: 'File name in Drive (defaults to the document\'s own title)' },
            folder_id: { type: 'string', description: 'Drive folder id to upload into (omit for My Drive root)' },
          },
          required: ['document_id'],
        },
        readOnly: false,
      },
      {
        name: 'sheets_read_range',
        description: 'Read a range of cells from a Google Sheet.',
        method: 'GET',
        path: '/v4/spreadsheets/{{spreadsheet_id}}/values/{{range}}',
        api_base: 'https://sheets.googleapis.com',
        input_schema: {
          type: 'object',
          properties: {
            spreadsheet_id: { type: 'string', description: 'The spreadsheet id from its URL' },
            range: { type: 'string', description: "A1 notation, e.g. 'Sheet1!A1:F50'" },
          },
          required: ['spreadsheet_id', 'range'],
        },
        readOnly: true,
      },
    ],
  },

  // --- Microsoft ------------------------------------------------------------
  microsoft: {
    name: 'Microsoft 365',
    description: 'Outlook mail, OneDrive, Teams, Excel and Calendar via Microsoft Graph.',
    category: 'Productivity',
    erp: true,
    authorize_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    api_base: 'https://graph.microsoft.com',
    scopes: ['offline_access', 'User.Read', 'Files.ReadWrite.All', 'Mail.ReadWrite', 'Calendars.ReadWrite', 'Sites.Read.All'],
    pkce: true,
    setup_url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    setup_hint: 'Register an application in Entra ID (Azure AD), add a Web redirect URI, then create a client secret under Certificates & secrets.',
    tools: [
      {
        name: 'onedrive_search_files',
        description: 'Search files across OneDrive and SharePoint document libraries.',
        method: 'GET',
        path: "/v1.0/me/drive/root/search(q='{{query}}')",
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Text to search for in file names and contents' } },
          required: ['query'],
        },
        readOnly: true,
      },
      {
        name: 'outlook_search_messages',
        description: 'Search Outlook mail using Microsoft Graph search syntax.',
        method: 'GET',
        path: '/v1.0/me/messages',
        query: { $search: '{{query}}', $top: '{{limit}}' },
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search text' },
            limit: { type: 'number', description: 'How many messages (default 20)' },
          },
          required: ['query'],
        },
        readOnly: true,
      },
    ],
  },

  // --- Communication --------------------------------------------------------
  slack: {
    name: 'Slack',
    description: 'Post and read messages, list channels and search a Slack workspace.',
    category: 'Communication',
    erp: true,
    authorize_url: 'https://slack.com/oauth/v2/authorize',
    token_url: 'https://slack.com/api/oauth.v2.access',
    api_base: 'https://slack.com/api',
    scopes: ['channels:read', 'channels:history', 'chat:write', 'users:read', 'search:read'],
    setup_url: 'https://api.slack.com/apps',
    setup_hint: 'Create an app, add the OAuth scopes under "OAuth & Permissions", and add the redirect URL there.',
    tools: [
      {
        name: 'slack_list_channels',
        description: 'List channels in the connected Slack workspace.',
        method: 'GET', path: '/conversations.list', query: { limit: '{{limit}}' },
        input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'How many channels (default 100)' } } },
        readOnly: true,
      },
      {
        name: 'slack_post_message',
        description: 'Post a message to a Slack channel. This is visible to everyone in that channel.',
        method: 'POST', path: '/chat.postMessage',
        body: { channel: '{{channel}}', text: '{{text}}' },
        input_schema: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'Channel id or name, e.g. C0123 or #general' },
            text: { type: 'string', description: 'The message to post' },
          },
          required: ['channel', 'text'],
        },
        readOnly: false,
      },
    ],
  },
  dropbox: {
    name: 'Dropbox',
    description: 'Files and folders in Dropbox.',
    category: 'Productivity', erp: false,
    authorize_url: 'https://www.dropbox.com/oauth2/authorize',
    token_url: 'https://api.dropboxapi.com/oauth2/token',
    api_base: 'https://api.dropboxapi.com',
    authorize_params: { token_access_type: 'offline' },
    scopes: ['files.metadata.read', 'files.content.read', 'files.content.write'],
    pkce: true,
    setup_url: 'https://www.dropbox.com/developers/apps',
    setup_hint: 'Create an app with "Full Dropbox" access, then add the redirect URI under Settings.',
    tools: [],
  },
  zoom: {
    name: 'Zoom',
    description: 'Meetings, recordings and participants in Zoom.',
    category: 'Communication', erp: false,
    authorize_url: 'https://zoom.us/oauth/authorize',
    token_url: 'https://zoom.us/oauth/token',
    api_base: 'https://api.zoom.us/v2',
    scopes: ['meeting:read', 'meeting:write', 'recording:read'],
    setup_url: 'https://marketplace.zoom.us/develop/create',
    setup_hint: 'Create a "General App" (user-managed), then add the redirect URL under OAuth.',
    tools: [],
  },

  // --- Project management ---------------------------------------------------
  atlassian: {
    name: 'Atlassian (Jira & Confluence)',
    description: 'Jira issues and Confluence pages.',
    category: 'Project management', erp: true,
    mcp_alternative: 'Atlassian (Jira & Confluence)',
    authorize_url: 'https://auth.atlassian.com/authorize',
    token_url: 'https://auth.atlassian.com/oauth/token',
    api_base: 'https://api.atlassian.com',
    authorize_params: { audience: 'api.atlassian.com', prompt: 'consent' },
    scopes: ['offline_access', 'read:jira-work', 'write:jira-work', 'read:confluence-content.all'],
    setup_url: 'https://developer.atlassian.com/console/myapps/',
    setup_hint: 'Create an OAuth 2.0 (3LO) app, add the Jira and Confluence scopes, then set the callback URL.',
    tools: [],
  },
  asana: {
    name: 'Asana',
    description: 'Tasks, projects and workspaces in Asana.',
    category: 'Project management', erp: false,
    mcp_alternative: 'Asana',
    authorize_url: 'https://app.asana.com/-/oauth_authorize',
    token_url: 'https://app.asana.com/-/oauth_token',
    api_base: 'https://app.asana.com/api/1.0',
    scopes: ['default'],
    setup_url: 'https://app.asana.com/0/my-apps',
    setup_hint: 'Create an app under My Apps and add the redirect URL.',
    tools: [],
  },
  trello: {
    name: 'Trello',
    description: 'Boards, lists and cards in Trello.',
    category: 'Project management', erp: false,
    authorize_url: 'https://trello.com/1/authorize',
    token_url: 'https://trello.com/1/OAuthGetAccessToken',
    api_base: 'https://api.trello.com/1',
    scopes: ['read', 'write'],
    setup_url: 'https://trello.com/power-ups/admin',
    setup_hint: 'Create a Power-Up to get an API key, then add the redirect URL.',
    tools: [],
  },
  clickup: {
    name: 'ClickUp',
    description: 'Tasks, lists and spaces in ClickUp.',
    category: 'Project management', erp: false,
    authorize_url: 'https://app.clickup.com/api',
    token_url: 'https://api.clickup.com/api/v2/oauth/token',
    api_base: 'https://api.clickup.com/api/v2',
    scopes: [],
    setup_url: 'https://app.clickup.com/settings/apps',
    setup_hint: 'Create an app in ClickUp settings and add the redirect URL.',
    tools: [],
  },
  notion: {
    name: 'Notion',
    description: 'Pages and databases in a Notion workspace.',
    category: 'Productivity', erp: true,
    mcp_alternative: 'Notion',
    authorize_url: 'https://api.notion.com/v1/oauth/authorize',
    token_url: 'https://api.notion.com/v1/oauth/token',
    api_base: 'https://api.notion.com',
    authorize_params: { owner: 'user' },
    scopes: [],
    extra_headers: { 'Notion-Version': '2022-06-28' },
    setup_url: 'https://www.notion.so/my-integrations',
    setup_hint: 'Create a public integration, then add the redirect URI under its OAuth settings.',
    tools: [
      {
        name: 'notion_search',
        description: 'Search pages and databases in the connected Notion workspace.',
        method: 'POST', path: '/v1/search', body: { query: '{{query}}' },
        input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Text to search for' } }, required: ['query'] },
        readOnly: true,
      },
    ],
  },

  // --- CRM ------------------------------------------------------------------
  salesforce: {
    name: 'Salesforce',
    description: 'Leads, opportunities, accounts and cases in Salesforce.',
    category: 'CRM', erp: true,
    authorize_url: 'https://login.salesforce.com/services/oauth2/authorize',
    token_url: 'https://login.salesforce.com/services/oauth2/token',
    // Salesforce returns the real API host as `instance_url` on the token
    // response; account_info.instance_url overrides this at call time.
    api_base: 'https://login.salesforce.com',
    instance_url_field: 'instance_url',
    scopes: ['api', 'refresh_token', 'offline_access'],
    pkce: true,
    setup_url: 'https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm',
    setup_hint: 'Create a Connected App with OAuth enabled, tick "api" and "refresh_token" scopes, and set the callback URL.',
    tools: [
      {
        name: 'salesforce_query',
        description: 'Run a SOQL query against Salesforce, e.g. "SELECT Id, Name FROM Account LIMIT 10".',
        method: 'GET', path: '/services/data/v60.0/query', query: { q: '{{soql}}' },
        input_schema: { type: 'object', properties: { soql: { type: 'string', description: 'The SOQL query' } }, required: ['soql'] },
        readOnly: true,
      },
    ],
  },
  hubspot: {
    name: 'HubSpot',
    description: 'Contacts, companies, deals and tickets in HubSpot.',
    category: 'CRM', erp: true,
    mcp_alternative: 'HubSpot',
    authorize_url: 'https://app.hubspot.com/oauth/authorize',
    token_url: 'https://api.hubapi.com/oauth/v1/token',
    api_base: 'https://api.hubapi.com',
    scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.deals.read', 'crm.objects.companies.read'],
    setup_url: 'https://developers.hubspot.com/docs/api/creating-an-app',
    setup_hint: 'Create an app in your HubSpot developer account, set the scopes and the redirect URL.',
    tools: [
      {
        name: 'hubspot_list_contacts',
        description: 'List contacts from the HubSpot CRM.',
        method: 'GET', path: '/crm/v3/objects/contacts', query: { limit: '{{limit}}' },
        input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'How many contacts (default 50)' } } },
        readOnly: true,
      },
    ],
  },
  pipedrive: {
    name: 'Pipedrive',
    description: 'Deals, persons, organisations and activities in Pipedrive.',
    category: 'CRM', erp: true,
    authorize_url: 'https://oauth.pipedrive.com/oauth/authorize',
    token_url: 'https://oauth.pipedrive.com/oauth/token',
    api_base: 'https://api.pipedrive.com/v1',
    scopes: ['deals:full', 'persons:full', 'organizations:full'],
    setup_url: 'https://developers.pipedrive.com/docs/api/v1/getting-started',
    setup_hint: 'Create an app in the Developer Hub and set its callback URL.',
    tools: [],
  },
  zohocrm: {
    name: 'Zoho CRM',
    description: 'Leads, accounts, contacts and deals in Zoho CRM.',
    category: 'CRM', erp: true,
    authorize_url: 'https://accounts.zoho.com/oauth/v2/auth',
    token_url: 'https://accounts.zoho.com/oauth/v2/token',
    api_base: 'https://www.zohoapis.com',
    authorize_params: { access_type: 'offline', prompt: 'consent' },
    scopes: ['ZohoCRM.modules.ALL', 'ZohoCRM.settings.READ'],
    setup_url: 'https://api-console.zoho.com/',
    setup_hint: 'Create a "Server-based Application" in the Zoho API console and set the redirect URI.',
    tools: [],
  },

  // --- Accounting & ERP -----------------------------------------------------
  xero: {
    name: 'Xero',
    description: 'Invoices, contacts, bank transactions and reports in Xero.',
    category: 'Accounting', erp: true,
    authorize_url: 'https://login.xero.com/identity/connect/authorize',
    token_url: 'https://identity.xero.com/connect/token',
    api_base: 'https://api.xero.com',
    scopes: ['offline_access', 'accounting.transactions', 'accounting.contacts', 'accounting.reports.read', 'accounting.settings'],
    pkce: true,
    // Xero needs the tenant id on every call; it is fetched after authorization
    // from /connections and stored in account_info.
    tenant_lookup: { path: '/connections', field: 'tenantId', header: 'Xero-Tenant-Id' },
    setup_url: 'https://developer.xero.com/app/manage',
    setup_hint: 'Create an app, choose "Web app", and add the redirect URI.',
    tools: [
      {
        name: 'xero_list_invoices',
        description: 'List sales invoices from Xero, newest first.',
        method: 'GET', path: '/api.xro/2.0/Invoices',
        extra_headers: { Accept: 'application/json' },
        input_schema: { type: 'object', properties: {} },
        readOnly: true,
      },
      {
        name: 'xero_list_contacts',
        description: 'List customers and suppliers from Xero.',
        method: 'GET', path: '/api.xro/2.0/Contacts',
        extra_headers: { Accept: 'application/json' },
        input_schema: { type: 'object', properties: {} },
        readOnly: true,
      },
    ],
  },
  quickbooks: {
    name: 'QuickBooks Online',
    description: 'Invoices, bills, customers and the chart of accounts in QuickBooks.',
    category: 'Accounting', erp: true,
    authorize_url: 'https://appcenter.intuit.com/connect/oauth2',
    token_url: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    api_base: 'https://quickbooks.api.intuit.com',
    scopes: ['com.intuit.quickbooks.accounting'],
    // realmId arrives as a query parameter on the callback, not in the token
    // response — it is the company id every API path needs.
    callback_params: ['realmId'],
    setup_url: 'https://developer.intuit.com/app/developer/dashboard',
    setup_hint: 'Create an app, enable the Accounting scope, and add the redirect URI under Keys & OAuth.',
    tools: [
      {
        name: 'quickbooks_query',
        description: 'Run a QuickBooks SQL-like query, e.g. "SELECT * FROM Invoice MAXRESULTS 20".',
        method: 'GET', path: '/v3/company/{{realmId}}/query', query: { query: '{{query}}', minorversion: '70' },
        extra_headers: { Accept: 'application/json' },
        input_schema: { type: 'object', properties: { query: { type: 'string', description: 'The query to run' } }, required: ['query'] },
        readOnly: true,
      },
    ],
  },
  netsuite: {
    name: 'Oracle NetSuite',
    description: 'Records and SuiteQL queries against NetSuite.',
    category: 'ERP', erp: true,
    authorize_url: 'https://{{account}}.app.netsuite.com/app/login/oauth2/authorize.nl',
    token_url: 'https://{{account}}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
    api_base: 'https://{{account}}.suitetalk.api.netsuite.com',
    scopes: ['rest_webservices'],
    account_param: { key: 'account', label: 'NetSuite account id', hint: 'The account id from your NetSuite URL, e.g. 1234567 or 1234567-sb1' },
    setup_url: 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_158074210415.html',
    setup_hint: 'Enable OAuth 2.0 in Setup → Company → Enable Features, then create an integration record.',
    tools: [],
  },
  dynamics365: {
    name: 'Microsoft Dynamics 365',
    description: 'Business Central and Dynamics CRM data.',
    category: 'ERP', erp: true,
    authorize_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    api_base: 'https://api.businesscentral.dynamics.com',
    scopes: ['offline_access', 'https://api.businesscentral.dynamics.com/.default'],
    pkce: true,
    setup_url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    setup_hint: 'Register an Entra ID app, grant it Dynamics permissions, and add the redirect URI.',
    tools: [],
  },
  odoo: {
    name: 'Odoo',
    description: 'Any Odoo model through its web JSON-RPC API.',
    category: 'ERP', erp: true,
    authorize_url: 'https://{{host}}/oauth2/auth',
    token_url: 'https://{{host}}/oauth2/token',
    api_base: 'https://{{host}}',
    scopes: [],
    account_param: { key: 'host', label: 'Odoo host', hint: 'Your Odoo domain, e.g. mycompany.odoo.com' },
    setup_url: 'https://www.odoo.com/documentation/master/developer/reference/external_api.html',
    setup_hint: 'Odoo Online requires the OAuth provider module; self-hosted installs configure it under Settings → Users.',
    tools: [],
  },
  sage: {
    name: 'Sage Accounting',
    description: 'Invoices, contacts and ledgers in Sage Business Cloud Accounting.',
    category: 'Accounting', erp: true,
    authorize_url: 'https://www.sageone.com/oauth2/auth/central',
    token_url: 'https://oauth.accounting.sage.com/token',
    api_base: 'https://api.accounting.sage.com/v3.1',
    authorize_params: { filter: 'apiv3.1' },
    scopes: ['full_access'],
    setup_url: 'https://developer.sage.com/accounting/',
    setup_hint: 'Register an app in the Sage developer portal and set the callback URL.',
    tools: [],
  },

  // --- E-commerce -----------------------------------------------------------
  shopify: {
    name: 'Shopify',
    description: 'Products, orders, customers and inventory in a Shopify store.',
    category: 'E-commerce', erp: true,
    mcp_alternative: 'Shopify Dev',
    authorize_url: 'https://{{shop}}/admin/oauth/authorize',
    token_url: 'https://{{shop}}/admin/oauth/access_token',
    api_base: 'https://{{shop}}',
    scopes: ['read_products', 'read_orders', 'read_customers', 'read_inventory'],
    account_param: { key: 'shop', label: 'Shop domain', hint: 'e.g. my-store.myshopify.com' },
    token_header: 'X-Shopify-Access-Token',
    setup_url: 'https://partners.shopify.com/',
    setup_hint: 'Create an app in the Shopify Partner dashboard and add the redirect URL under App setup.',
    tools: [
      {
        name: 'shopify_list_orders',
        description: 'List recent orders from the connected Shopify store.',
        method: 'GET', path: '/admin/api/2024-10/orders.json', query: { limit: '{{limit}}', status: 'any' },
        input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'How many orders (default 50)' } } },
        readOnly: true,
      },
    ],
  },
  bigcommerce: {
    name: 'BigCommerce',
    description: 'Catalog, orders and customers in BigCommerce.',
    category: 'E-commerce', erp: true,
    authorize_url: 'https://login.bigcommerce.com/oauth2/authorize',
    token_url: 'https://login.bigcommerce.com/oauth2/token',
    api_base: 'https://api.bigcommerce.com',
    scopes: ['store_v2_orders', 'store_v2_products'],
    setup_url: 'https://devtools.bigcommerce.com/',
    setup_hint: 'Create an app in the BigCommerce developer portal with the auth callback URL.',
    tools: [],
  },
  woocommerce: {
    name: 'WooCommerce',
    description: 'Orders, products and customers on a WooCommerce store.',
    category: 'E-commerce', erp: true,
    authorize_url: 'https://{{host}}/wc-auth/v1/authorize',
    token_url: null, // WooCommerce issues keys directly rather than OAuth tokens
    api_base: 'https://{{host}}/wp-json/wc/v3',
    account_param: { key: 'host', label: 'Store domain', hint: 'e.g. shop.example.com' },
    auth_style: 'basic',
    setup_url: 'https://woocommerce.com/document/woocommerce-rest-api/',
    setup_hint: 'Generate REST API keys under WooCommerce → Settings → Advanced → REST API, then paste them as the client id and secret.',
    tools: [],
  },

  // --- Development ----------------------------------------------------------
  github: {
    name: 'GitHub',
    description: 'Repositories, issues, pull requests and Actions on GitHub.',
    category: 'Development', erp: false,
    mcp_alternative: 'GitHub',
    authorize_url: 'https://github.com/login/oauth/authorize',
    token_url: 'https://github.com/login/oauth/access_token',
    api_base: 'https://api.github.com',
    scopes: ['repo', 'read:org'],
    setup_url: 'https://github.com/settings/developers',
    setup_hint: 'Create an OAuth App (not a GitHub App) and set the authorization callback URL.',
    tools: [
      {
        name: 'github_search_issues',
        description: 'Search issues and pull requests across GitHub, e.g. "repo:owner/name is:open label:bug".',
        method: 'GET', path: '/search/issues', query: { q: '{{query}}', per_page: '{{limit}}' },
        input_schema: { type: 'object', properties: { query: { type: 'string', description: 'GitHub search query' }, limit: { type: 'number' } }, required: ['query'] },
        readOnly: true,
      },
    ],
  },
  gitlab: {
    name: 'GitLab',
    description: 'Projects, issues and merge requests on GitLab.',
    category: 'Development', erp: false,
    authorize_url: 'https://gitlab.com/oauth/authorize',
    token_url: 'https://gitlab.com/oauth/token',
    api_base: 'https://gitlab.com/api/v4',
    scopes: ['api', 'read_user'],
    pkce: true,
    setup_url: 'https://gitlab.com/-/profile/applications',
    setup_hint: 'Create an application under User Settings → Applications with the api scope.',
    tools: [],
  },
  bitbucket: {
    name: 'Bitbucket',
    description: 'Repositories, issues and pull requests on Bitbucket.',
    category: 'Development', erp: false,
    authorize_url: 'https://bitbucket.org/site/oauth2/authorize',
    token_url: 'https://bitbucket.org/site/oauth2/access_token',
    api_base: 'https://api.bitbucket.org/2.0',
    scopes: ['repository', 'issue'],
    setup_url: 'https://bitbucket.org/account/settings/app-passwords/',
    setup_hint: 'Add an OAuth consumer under Workspace settings with the callback URL.',
    tools: [],
  },

  // --- Cloud ----------------------------------------------------------------
  digitalocean: {
    name: 'DigitalOcean',
    description: 'Droplets, databases and spaces on DigitalOcean.',
    category: 'Cloud', erp: false,
    authorize_url: 'https://cloud.digitalocean.com/v1/oauth/authorize',
    token_url: 'https://cloud.digitalocean.com/v1/oauth/token',
    api_base: 'https://api.digitalocean.com/v2',
    scopes: ['read', 'write'],
    setup_url: 'https://cloud.digitalocean.com/account/api/applications',
    setup_hint: 'Register an OAuth application and set the redirect URI.',
    tools: [],
  },

  // --- Marketing ------------------------------------------------------------
  mailchimp: {
    name: 'Mailchimp',
    description: 'Audiences, campaigns and reports in Mailchimp.',
    category: 'Marketing', erp: true,
    authorize_url: 'https://login.mailchimp.com/oauth2/authorize',
    token_url: 'https://login.mailchimp.com/oauth2/token',
    api_base: 'https://login.mailchimp.com',
    scopes: [],
    setup_url: 'https://us1.admin.mailchimp.com/account/oauth2/',
    setup_hint: 'Register an app under Account → Extras → API keys → Registered apps.',
    tools: [],
  },
  klaviyo: {
    name: 'Klaviyo',
    description: 'Profiles, lists, flows and campaigns in Klaviyo.',
    category: 'Marketing', erp: true,
    authorize_url: 'https://www.klaviyo.com/oauth/authorize',
    token_url: 'https://a.klaviyo.com/oauth/token',
    api_base: 'https://a.klaviyo.com/api',
    scopes: ['profiles:read', 'lists:read', 'campaigns:read'],
    pkce: true,
    extra_headers: { revision: '2024-10-15' },
    setup_url: 'https://www.klaviyo.com/manage-apps',
    setup_hint: 'Create an app under Manage Apps and add the redirect URI.',
    tools: [],
  },
  linkedin: {
    name: 'LinkedIn',
    description: 'Organisation pages, posts and analytics on LinkedIn.',
    category: 'Marketing', erp: false,
    authorize_url: 'https://www.linkedin.com/oauth/v2/authorization',
    token_url: 'https://www.linkedin.com/oauth/v2/accessToken',
    api_base: 'https://api.linkedin.com',
    scopes: ['r_organization_social', 'w_organization_social'],
    setup_url: 'https://www.linkedin.com/developers/apps',
    setup_hint: 'Create an app, request the Marketing Developer Platform product, and add the redirect URL.',
    tools: [],
  },
  meta: {
    name: 'Meta (Facebook & Instagram)',
    description: 'Pages, posts, ads and Instagram business accounts.',
    category: 'Marketing', erp: false,
    authorize_url: 'https://www.facebook.com/v21.0/dialog/oauth',
    token_url: 'https://graph.facebook.com/v21.0/oauth/access_token',
    api_base: 'https://graph.facebook.com/v21.0',
    scopes: ['pages_read_engagement', 'pages_manage_posts', 'instagram_basic'],
    setup_url: 'https://developers.facebook.com/apps/',
    setup_hint: 'Create an app, add Facebook Login, and set the valid OAuth redirect URI.',
    tools: [],
  },

  // --- Payments -------------------------------------------------------------
  stripe: {
    name: 'Stripe',
    description: 'Payments, customers, invoices and subscriptions in Stripe.',
    category: 'Payments', erp: true,
    mcp_alternative: 'Stripe',
    authorize_url: 'https://connect.stripe.com/oauth/authorize',
    token_url: 'https://connect.stripe.com/oauth/token',
    api_base: 'https://api.stripe.com',
    scopes: ['read_write'],
    setup_url: 'https://dashboard.stripe.com/settings/connect',
    setup_hint: 'Enable Connect and add the redirect URI under Connect settings. For a single account, an API key connector is simpler.',
    tools: [
      {
        name: 'stripe_list_payments',
        description: 'List recent payment intents from Stripe.',
        method: 'GET', path: '/v1/payment_intents', query: { limit: '{{limit}}' },
        input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'How many (default 20)' } } },
        readOnly: true,
      },
    ],
  },
  paypal: {
    name: 'PayPal',
    description: 'Invoices, orders, payments and disputes in PayPal.',
    category: 'Payments', erp: true,
    mcp_alternative: 'PayPal',
    authorize_url: 'https://www.paypal.com/connect',
    token_url: 'https://api-m.paypal.com/v1/oauth2/token',
    api_base: 'https://api-m.paypal.com',
    scopes: ['openid', 'https://uri.paypal.com/services/invoicing'],
    setup_url: 'https://developer.paypal.com/dashboard/applications/live',
    setup_hint: 'Create a REST app in the PayPal developer dashboard and add the return URL.',
    tools: [],
  },
  square: {
    name: 'Square',
    description: 'Payments, orders, catalog and inventory for Square sellers.',
    category: 'Payments', erp: true,
    mcp_alternative: 'Square',
    authorize_url: 'https://connect.squareup.com/oauth2/authorize',
    token_url: 'https://connect.squareup.com/oauth2/token',
    api_base: 'https://connect.squareup.com',
    scopes: ['PAYMENTS_READ', 'ORDERS_READ', 'ITEMS_READ', 'INVENTORY_READ'],
    setup_url: 'https://developer.squareup.com/apps',
    setup_hint: 'Create an application and set the redirect URL under OAuth.',
    tools: [],
  },
  adyen: {
    name: 'Adyen',
    description: 'Payments and payouts through the Adyen platform.',
    category: 'Payments', erp: true,
    authorize_url: 'https://ca-live.adyen.com/ca/ca/oauth/connect.shtml',
    token_url: 'https://oauth-live.adyen.com/v1/token',
    api_base: 'https://management-live.adyen.com/v3',
    scopes: ['psp.onboarding:write', 'management:read'],
    setup_url: 'https://docs.adyen.com/development-resources/oauth/',
    setup_hint: 'Register an OAuth client in the Adyen Customer Area.',
    tools: [],
  },

  // --- AI & automation ------------------------------------------------------
  zapier: {
    name: 'Zapier',
    description: 'Trigger Zaps and reach thousands of connected apps.',
    category: 'Automation', erp: true,
    mcp_alternative: 'Zapier',
    authorize_url: 'https://zapier.com/oauth/authorize/',
    token_url: 'https://zapier.com/oauth/token/',
    api_base: 'https://api.zapier.com/v1',
    scopes: ['zap'],
    setup_url: 'https://developer.zapier.com/',
    setup_hint: 'Create an integration in the Zapier developer platform. The hosted MCP connector is usually simpler than this.',
    tools: [],
  },
};

/**
 * The OAuth application this server uses for a provider, if the operator has
 * configured one.
 *
 * This is the difference between a product and a toolkit. An OAuth app belongs
 * to whoever runs the deployment, not to each person using it — so it is
 * configured ONCE in the environment, and everyone on the server then just
 * signs in. That is how every hosted AI product works: the vendor registered
 * one Google app, and users only ever see a consent screen.
 *
 *   CONNECTOR_GOOGLE_CLIENT_ID / CONNECTOR_GOOGLE_CLIENT_SECRET
 *   CONNECTOR_XERO_CLIENT_ID   / CONNECTOR_XERO_CLIENT_SECRET   ... and so on.
 *
 * When these are absent the per-connection fields are still offered, so a
 * single admin connecting their own account does not have to touch .env — but
 * that is the fallback, not the intended path for a shared server.
 */
function envCredentials(key) {
  const prefix = `CONNECTOR_${key.toUpperCase()}`;
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;
  return { client_id: clientId.trim(), client_secret: clientSecret.trim() };
}

/** Providers as a browsable list. */
function listProviders() {
  return Object.entries(PROVIDERS).map(([key, p]) => ({
    key,
    name: p.name,
    description: p.description,
    category: p.category,
    erp: !!p.erp,
    setup_url: p.setup_url,
    setup_hint: p.setup_hint,
    setup_steps: p.setup_steps || null,
    // When the same product also publishes an MCP server, that route needs no
    // OAuth app at all — the server issues a client id itself via dynamic
    // registration. Surfaced so nobody is sent to a developer console for
    // something they could connect in one click.
    mcp_alternative: p.mcp_alternative || null,
    // True when this server already holds an OAuth app for the provider, so a
    // person connecting it sees a sign-in button and nothing else.
    preconfigured: !!envCredentials(key),
    env_var_prefix: `CONNECTOR_${key.toUpperCase()}`,
    client_id_example: p.client_id_example || null,
    client_secret_example: p.client_secret_example || null,
    scopes: p.scopes || [],
    account_param: p.account_param || null,
    tool_count: (p.tools || []).length,
  }));
}

/**
 * Is this plausibly the client ID the provider issues?
 *
 * Checked because the failure it prevents is genuinely opaque: an ID the
 * provider does not recognise produces "invalid_client" on the provider's own
 * error page, long after leaving this app, with nothing pointing back at the
 * field that was wrong. Entering an account email instead of an OAuth client ID
 * is the obvious mistake to make — the words "client" and "ID" both suggest it
 * — so it is worth catching here rather than three redirects later.
 */
function validateClientId(key, clientId) {
  const config = PROVIDERS[key];
  const value = String(clientId || '').trim();
  if (!config) return null;

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return `That looks like an email address. ${config.name} needs the OAuth *client ID* issued when you create an app in its console — not the account you sign in with.`
      + (config.client_id_example ? ` It looks like: ${config.client_id_example}` : '');
  }
  if (config.client_id_pattern && !new RegExp(config.client_id_pattern).test(value)) {
    return `That does not look like a ${config.name} client ID.`
      + (config.client_id_example ? ` They look like: ${config.client_id_example}` : '');
  }
  if (value.length < 8) {
    return `That client ID looks too short to be real.`;
  }
  return null;
}

function getProvider(key) {
  return PROVIDERS[key] || null;
}

const CATEGORIES = [...new Set(Object.values(PROVIDERS).map((p) => p.category))].sort();

module.exports = { PROVIDERS, listProviders, getProvider, validateClientId, envCredentials, CATEGORIES };
