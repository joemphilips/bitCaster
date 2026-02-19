# ---------------------------------------------------------------------------
# Azure Database for PostgreSQL Flexible Server — CDK mintd state backend
# ---------------------------------------------------------------------------

variable "resource_group_name" { type = string }
variable "location"            { type = string }
variable "project_name"        { type = string }
variable "key_vault_id"        { type = string }
variable "common_tags"         { type = map(string) }

resource "random_password" "db" {
  length  = 32
  special = true
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                   = "${var.project_name}-db"
  resource_group_name    = var.resource_group_name
  location               = var.location
  version                = "15"
  administrator_login    = "bitcaster"
  administrator_password = random_password.db.result
  sku_name               = "B_Standard_B1ms"   # burstable, 1 vCore

  storage_mb = 32768   # 32 GB

  backup_retention_days        = 7
  geo_redundant_backup_enabled = false

  tags = var.common_tags
}

resource "azurerm_postgresql_flexible_server_database" "mintd" {
  name      = "mintd"
  server_id = azurerm_postgresql_flexible_server.main.id
  collation = "en_US.utf8"
  charset   = "utf8"
}

# Firewall: allow Azure services (Container Apps) to connect
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

# Store connection string in Key Vault
resource "azurerm_key_vault_secret" "db_connection_string" {
  name         = "db-connection-string"
  value        = "postgresql://bitcaster:${random_password.db.result}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/mintd?sslmode=require"
  key_vault_id = var.key_vault_id
}

output "connection_string" {
  description = "PostgreSQL connection string for CDK mintd"
  value       = azurerm_key_vault_secret.db_connection_string.value
  sensitive   = true
}

output "server_fqdn" {
  description = "Fully qualified domain name of the PostgreSQL server"
  value       = azurerm_postgresql_flexible_server.main.fqdn
}
