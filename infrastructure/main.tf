terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }

  # Uncomment to store state in Azure Blob Storage
  # backend "azurerm" {
  #   resource_group_name  = "bitcaster-tfstate"
  #   storage_account_name = "bitcastertfstate"
  #   container_name       = "tfstate"
  #   key                  = "bitcaster.tfstate"
  # }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
  }
}

# ---------------------------------------------------------------------------
# Resource Group
# ---------------------------------------------------------------------------

resource "azurerm_resource_group" "main" {
  name     = var.resource_group_name
  location = var.location

  tags = var.common_tags
}

# ---------------------------------------------------------------------------
# Key Vault (mint keys, DB credentials)
# ---------------------------------------------------------------------------

data "azurerm_client_config" "current" {}

resource "azurerm_key_vault" "main" {
  name                        = "${var.project_name}-kv"
  resource_group_name         = azurerm_resource_group.main.name
  location                    = azurerm_resource_group.main.location
  tenant_id                   = data.azurerm_client_config.current.tenant_id
  sku_name                    = "standard"
  soft_delete_retention_days  = 7
  purge_protection_enabled    = false

  access_policy {
    tenant_id = data.azurerm_client_config.current.tenant_id
    object_id = data.azurerm_client_config.current.object_id

    secret_permissions = [
      "Get", "List", "Set", "Delete", "Purge"
    ]
  }

  tags = var.common_tags
}

# ---------------------------------------------------------------------------
# Modules
# ---------------------------------------------------------------------------

module "database" {
  source = "./modules/database"

  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  project_name        = var.project_name
  key_vault_id        = azurerm_key_vault.main.id
  common_tags         = var.common_tags
}

module "mint" {
  source = "./modules/mint"

  resource_group_name  = azurerm_resource_group.main.name
  location             = azurerm_resource_group.main.location
  project_name         = var.project_name
  database_url         = module.database.connection_string
  key_vault_id         = azurerm_key_vault.main.id
  mint_image           = var.mint_image
  common_tags          = var.common_tags

  depends_on = [module.database]
}

module "frontend" {
  source = "./modules/frontend"

  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  project_name        = var.project_name
  common_tags         = var.common_tags
}
