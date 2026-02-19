# ---------------------------------------------------------------------------
# Azure Container Apps — CDK mintd
# ---------------------------------------------------------------------------

variable "resource_group_name" { type = string }
variable "location"            { type = string }
variable "project_name"        { type = string }
variable "database_url"        { type = string; sensitive = true }
variable "key_vault_id"        { type = string }
variable "mint_image"          { type = string }
variable "common_tags"         { type = map(string) }

# Container Apps Environment (shared Log Analytics workspace)
resource "azurerm_log_analytics_workspace" "mint" {
  name                = "${var.project_name}-mint-logs"
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.common_tags
}

resource "azurerm_container_app_environment" "main" {
  name                       = "${var.project_name}-cae"
  resource_group_name        = var.resource_group_name
  location                   = var.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.mint.id
  tags                       = var.common_tags
}

# Mint key secret stored in Key Vault
resource "azurerm_key_vault_secret" "mint_private_key" {
  name         = "mint-private-key"
  # In production, generate and store a real key; this is a placeholder.
  value        = "REPLACE_WITH_REAL_MINT_PRIVATE_KEY"
  key_vault_id = var.key_vault_id

  lifecycle {
    ignore_changes = [value]
  }
}

resource "azurerm_container_app" "mintd" {
  name                         = "${var.project_name}-mintd"
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"

  secret {
    name  = "database-url"
    value = var.database_url
  }

  secret {
    name  = "mint-private-key"
    value = azurerm_key_vault_secret.mint_private_key.value
  }

  template {
    container {
      name   = "mintd"
      image  = var.mint_image
      cpu    = 0.5
      memory = "1Gi"

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }

      env {
        name        = "MINT_PRIVATE_KEY"
        secret_name = "mint-private-key"
      }

      env {
        name  = "MINT_LISTEN_HOST"
        value = "0.0.0.0"
      }

      env {
        name  = "MINT_LISTEN_PORT"
        value = "3338"
      }
    }

    min_replicas = 1
    max_replicas = 3
  }

  ingress {
    external_enabled = true
    target_port      = 3338

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  tags = var.common_tags
}

output "url" {
  description = "HTTPS URL of the CDK mintd Container App"
  value       = "https://${azurerm_container_app.mintd.ingress[0].fqdn}"
}

output "fqdn" {
  description = "Fully qualified domain name of the mint Container App"
  value       = azurerm_container_app.mintd.ingress[0].fqdn
}
