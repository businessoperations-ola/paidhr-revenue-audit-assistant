// Revenue & Data Audit Assistant: phase 1 Azure infrastructure.
//
// Private by default: Postgres has no public endpoint and lives in a delegated
// subnet; the Container Apps environment runs in the same VNet; secrets are read
// from Key Vault by a managed identity. Only the API has public ingress.
//
// Deploy:  az deployment group create -g <rg> -f infra/main.bicep -p infra/main.parameters.json
// Secrets: create them in Key Vault first (see README, "Deploying to Azure").

targetScope = 'resourceGroup'

@description('Short environment name, e.g. dev, staging, prod.')
@allowed(['dev', 'staging', 'prod'])
param env string

@description('Azure region. South Africa North is the closest region to Lagos.')
param location string = 'southafricanorth'

@description('Container image tag to deploy, e.g. a git SHA.')
param imageTag string

@description('Google Workspace domain staff sign in with, e.g. paidhr.com.')
param googleWorkspaceDomain string

@description('OAuth client id of the admin web app (Google Cloud console).')
param googleOAuthClientId string

@description('Address the CX alerts are sent from (a Workspace mailbox or group).')
param mailFrom string

@description('Where alerts go when a HubSpot company has no CSM (comma-separated).')
param fallbackAlertEmails string

@description('Postgres administrator login. The password comes from Key Vault at deploy time.')
param postgresAdminLogin string = 'auditadmin'

@secure()
@description('Postgres administrator password (pass from Key Vault in the parameters file).')
param postgresAdminPassword string

@description('Send real alerts (false = log only). Keep false until the CX team signs off each alert type.')
param alertsLive bool = false

@description('Turn on Claude write-ups on alerts.')
param aiRationaleEnabled bool = false

@description('Microsoft Foundry resource name hosting Claude (only used when aiRationaleEnabled).')
param foundryResource string = ''

@description('Public URL of the API for alert links. Leave empty to use the Container Apps default address.')
param publicBaseUrl string = ''

var prefix = 'audit-${env}'
var tags = { app: 'revenue-audit-assistant', env: env }
var uniq = uniqueString(resourceGroup().id)

// ---------- Monitoring ----------
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

// ---------- Network ----------
resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: '${prefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: '10.40.0.0/23'
          delegations: [{ name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: '10.40.2.0/24'
          delegations: [{ name: 'pg', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
        }
      }
    ]
  }
}

resource pgDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: '${prefix}.private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource pgDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: pgDnsZone
  name: '${prefix}-vnet-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}

// ---------- Audit database ----------
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: '${prefix}-pg-${uniq}'
  location: location
  tags: tags
  sku: { name: env == 'prod' ? 'Standard_D2ds_v5' : 'Standard_B2ms', tier: env == 'prod' ? 'GeneralPurpose' : 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 64, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: env == 'prod' ? 35 : 7, geoRedundantBackup: env == 'prod' ? 'Enabled' : 'Disabled' }
    network: {
      delegatedSubnetResourceId: '${vnet.id}/subnets/postgres'
      privateDnsZoneArmResourceId: pgDnsZone.id
      publicNetworkAccess: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
  }
  dependsOn: [pgDnsLink]
}

resource auditDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgres
  name: 'audit'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// ---------- Identity, registry, secrets ----------
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-id'
  location: location
  tags: tags
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: replace('${prefix}acr${uniq}', '-', '')
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('${prefix}-kv-${uniq}', 24)
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
  }
}

var acrPullRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var kvSecretsUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, identity.id, 'acrpull')
  properties: { roleDefinitionId: acrPullRole, principalId: identity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource kvRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, identity.id, 'kvsecrets')
  properties: { roleDefinitionId: kvSecretsUserRole, principalId: identity.properties.principalId, principalType: 'ServicePrincipal' }
}

// ---------- Container Apps ----------
resource appsEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  tags: tags
  properties: {
    vnetConfiguration: { infrastructureSubnetId: '${vnet.id}/subnets/apps', internal: false }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

var image = '${acr.properties.loginServer}/audit-assistant:${imageTag}'
// The API's default address is known from the environment, so the API and the jobs can both use it.
var apiBaseUrl = empty(publicBaseUrl) ? 'https://${prefix}-api.${appsEnv.properties.defaultDomain}' : publicBaseUrl
// Built from the vault's name, not keyVault.properties.vaultUri: the secrets list below is a
// variable loop, and Bicep requires its values to be known before deployment starts (BCP182).
var kv = 'https://${keyVault.name}${environment().suffixes.keyvaultDns}/'

// Secrets live in Key Vault under these names; the apps read them via the managed identity.
// All must exist before deploying (use a placeholder value for any channel not in use yet).
var secretNames = [
  'database-url'
  'control-panel-database-url'
  'hubspot-token'
  'smtp-user'
  'smtp-password'
  'google-chat-webhook'
  'ack-link-secret'
  'foundry-api-key'
]
var secrets = [for s in secretNames: { name: s, keyVaultUrl: '${kv}secrets/${s}', identity: identity.id }]

var envVars = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'SOURCE_MODE', value: 'live' }
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'CONTROL_PANEL_DATABASE_URL', secretRef: 'control-panel-database-url' }
  { name: 'HUBSPOT_TOKEN', secretRef: 'hubspot-token' }
  { name: 'ALERT_CHANNELS', value: 'google_chat,email,hubspot_task' }
  { name: 'ALERTS_DRY_RUN', value: alertsLive ? 'false' : 'true' }
  { name: 'GOOGLE_CHAT_DEFAULT_WEBHOOK', secretRef: 'google-chat-webhook' }
  { name: 'SMTP_HOST', value: 'smtp.gmail.com' }
  { name: 'SMTP_PORT', value: '465' }
  { name: 'SMTP_USER', secretRef: 'smtp-user' }
  { name: 'SMTP_PASSWORD', secretRef: 'smtp-password' }
  { name: 'MAIL_FROM', value: mailFrom }
  { name: 'FALLBACK_ALERT_EMAILS', value: fallbackAlertEmails }
  { name: 'ACK_LINK_SECRET', secretRef: 'ack-link-secret' }
  { name: 'GOOGLE_OAUTH_CLIENT_ID', value: googleOAuthClientId }
  { name: 'GOOGLE_WORKSPACE_DOMAIN', value: googleWorkspaceDomain }
  { name: 'AI_RATIONALE_ENABLED', value: aiRationaleEnabled ? 'true' : 'false' }
  { name: 'CLAUDE_PROVIDER', value: 'foundry' }
  { name: 'ANTHROPIC_FOUNDRY_API_KEY', secretRef: 'foundry-api-key' }
  { name: 'ANTHROPIC_FOUNDRY_RESOURCE', value: foundryResource }
  { name: 'APP_BASE_URL', value: apiBaseUrl }
]

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-api'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: appsEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      ingress: { external: true, targetPort: 8080, transport: 'auto', allowInsecure: false }
      registries: [{ server: acr.properties.loginServer, identity: identity.id }]
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(envVars, [{ name: 'PORT', value: '8080' }])
          probes: [
            { type: 'Liveness', httpGet: { path: '/health', port: 8080 }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/health', port: 8080 }, periodSeconds: 10 }
          ]
        }
      ]
      scale: { minReplicas: env == 'prod' ? 1 : 0, maxReplicas: 3 }
    }
  }
  dependsOn: [acrPull, kvRead]
}

@description('Container Apps Jobs: cron is in UTC. 03:00 UTC = 04:00 WAT.')
var jobs = [
  { name: 'daily', cron: '0 3 * * *', args: ['dist/cli.js', 'daily'], timeout: 3600 }
  // Retries failed alert deliveries during working hours (08:15–18:15 WAT, Mon–Fri).
  { name: 'dispatch', cron: '15 7-17 * * 1-5', args: ['dist/cli.js', 'dispatch'], timeout: 900 }
  // US-16: escalate unacknowledged alerts at 08:00 WAT (07:00 UTC), Monday to Friday.
  { name: 'escalate', cron: '0 7 * * 1-5', args: ['dist/cli.js', 'escalate'], timeout: 900 }
]

resource scheduled 'Microsoft.App/jobs@2024-03-01' = [for j in jobs: {
  name: '${prefix}-job-${j.name}'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: appsEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: { cronExpression: j.cron, parallelism: 1, replicaCompletionCount: 1 }
      replicaTimeout: j.timeout
      replicaRetryLimit: 1
      registries: [{ server: acr.properties.loginServer, identity: identity.id }]
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: j.name
          image: image
          command: ['node']
          args: j.args
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: envVars
        }
      ]
    }
  }
  dependsOn: [acrPull, kvRead]
}]

output apiUrl string = apiBaseUrl
output acrLoginServer string = acr.properties.loginServer
output keyVaultName string = keyVault.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
