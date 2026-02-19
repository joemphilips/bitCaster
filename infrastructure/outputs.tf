output "mint_url" {
  description = "Public HTTPS URL of the CDK mintd Container App"
  value       = module.mint.url
}

output "frontend_url" {
  description = "Default hostname of the Azure Static Web App"
  value       = module.frontend.default_hostname
}

output "key_vault_uri" {
  description = "URI of the Key Vault storing secrets"
  value       = azurerm_key_vault.main.vault_uri
}

output "resource_group_name" {
  description = "Resource group containing all bitCaster resources"
  value       = azurerm_resource_group.main.name
}
